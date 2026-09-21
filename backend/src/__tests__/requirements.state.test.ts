import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequirementStatus, Prisma } from '@prisma/client';
import {
  REQUIREMENT_TRANSITIONS,
  canRequirementTransition,
  requirementStatusesLeadingTo,
} from '../utils/requirementState';

const ALL: RequirementStatus[] = Object.values(RequirementStatus) as RequirementStatus[];

const VALID_PAIRS: Array<[RequirementStatus, RequirementStatus]> = [
  ['OPEN', 'PARTIALLY_FULFILLED'],
  ['OPEN', 'EXPIRED'],
  ['OPEN', 'CANCELLED'],
  ['PARTIALLY_FULFILLED', 'FULFILLED'],
];
const VALID_SET = new Set(VALID_PAIRS.map(([f, t]) => `${f}->${t}`));

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

describe('REQ-04 requirement state machine', () => {
  it('exposes exactly the authoritative transition map', () => {
    expect(REQUIREMENT_TRANSITIONS).toEqual({
      OPEN: ['PARTIALLY_FULFILLED', 'EXPIRED', 'CANCELLED'],
      PARTIALLY_FULFILLED: ['FULFILLED'],
      FULFILLED: [],
      EXPIRED: [],
      CANCELLED: [],
    });
  });

  it.each(VALID_PAIRS)('canRequirementTransition(%s, %s) === true', (from, to) => {
    expect(canRequirementTransition(from, to)).toBe(true);
  });

  it('rejects every pair not in the authoritative map (exhaustive 5x5)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = VALID_SET.has(`${from}->${to}`);
        expect(canRequirementTransition(from, to), `${from}->${to}`).toBe(expected);
      }
    }
  });

  it('rejects self-transitions', () => {
    for (const s of ALL) {
      expect(canRequirementTransition(s, s), `${s}->${s}`).toBe(false);
    }
  });

  it('treats FULFILLED / EXPIRED / CANCELLED as terminal', () => {
    for (const terminal of ['FULFILLED', 'EXPIRED', 'CANCELLED'] as const) {
      for (const to of ALL) {
        expect(canRequirementTransition(terminal, to), `${terminal}->${to}`).toBe(false);
      }
    }
  });

  it('does not authorize PARTIALLY_FULFILLED → CANCELLED/EXPIRED or backward transitions', () => {
    expect(canRequirementTransition('PARTIALLY_FULFILLED', 'CANCELLED')).toBe(false);
    expect(canRequirementTransition('PARTIALLY_FULFILLED', 'EXPIRED')).toBe(false);
    expect(canRequirementTransition('PARTIALLY_FULFILLED', 'OPEN')).toBe(false);
    expect(canRequirementTransition('FULFILLED', 'OPEN')).toBe(false);
    expect(canRequirementTransition('CANCELLED', 'OPEN')).toBe(false);
    expect(canRequirementTransition('EXPIRED', 'OPEN')).toBe(false);
    // OPEN → FULFILLED is conditional on unresolved D-06 and must not be present
    expect(canRequirementTransition('OPEN', 'FULFILLED')).toBe(false);
  });

  it('derives leading statuses from the single transition map', () => {
    expect(requirementStatusesLeadingTo('PARTIALLY_FULFILLED')).toEqual(['OPEN']);
    expect(requirementStatusesLeadingTo('FULFILLED')).toEqual(['PARTIALLY_FULFILLED']);
    expect(requirementStatusesLeadingTo('EXPIRED')).toEqual(['OPEN']);
    expect(requirementStatusesLeadingTo('CANCELLED')).toEqual(['OPEN']);
    expect(requirementStatusesLeadingTo('OPEN')).toEqual([]);
  });

  it('is pure — no DB/audit/notification/allocation side effects in the module', () => {
    const src = readRepoFile('src', 'utils', 'requirementState.ts');
    // No DB/audit/notification/allocation MECHANICS. (`@prisma/client` is
    // imported for the RequirementStatus enum only; the word `quantityFulfilled`
    // may appear in comments but must never be assigned/mutated.)
    for (const forbidden of [
      'getPrisma',
      'persistAuditEvent',
      'updateMany',
      '.update(',
      '.create(',
      'Allocation',
      'quantity_remaining',
      'quantityRemaining',
      'cron',
      'setInterval',
      'setTimeout',
    ]) {
      expect(src).not.toContain(forbidden);
    }
    expect(src).not.toMatch(/quantityFulfilled\s*[:=]/);
  });
});

describe('REQ-04 D-06 boundary (authoritative Allocation present; no competing/remaining mechanics)', () => {
  it('has the authoritative Allocation model and no quantity_remaining / competing fulfillment model', () => {
    const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
    // REQ-08 / D-06 (Model A) is authoritative: Allocation exists.
    expect(models).toContain('Allocation');
    expect(models).not.toContain('DonationAllocation');
    expect(models).not.toContain('Fulfillment');
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        expect(field.name, `${model.name}.${field.name}`).not.toMatch(/quantityRemaining|quantity_remaining/);
      }
    }
    const schema = readRepoFile('prisma', 'schema.prisma');
    expect(schema).toMatch(/model\s+Allocation/);
    expect(schema).not.toMatch(/quantity_remaining|quantityRemaining/);
  });

  it('does not mutate quantityFulfilled through the state machine', () => {
    // The guard only returns a boolean; quantityFulfilled is untouched and
    // remains server-controlled (REQ-01 default 0 / future delivery confirm).
    expect(typeof canRequirementTransition('OPEN', 'PARTIALLY_FULFILLED')).toBe('boolean');
    const src = readRepoFile('src', 'utils', 'requirementState.ts');
    expect(src).not.toMatch(/quantityFulfilled\s*[:=]/);
    expect(src).not.toContain('updateMany');
  });
});

describe('REQ-04 D-10 boundary (no expiry automation) + no status-mutation bypass', () => {
  it('adds no scheduling/cron dependency', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    for (const dep of deps) {
      expect(dep).not.toMatch(/cron|agenda|bree|node-schedule|bull|worker/i);
    }
  });

  it('exposes no generic status/expire/override endpoint', () => {
    const routes = readRepoFile('src', 'routes', 'requirements.ts');
    for (const forbidden of ["'/status'", "'/expire'", "'/override'", 'canRequirementTransition']) {
      expect(routes).not.toContain(forbidden);
    }
    // REQ-07 adds the owner-organization cancel action, not a generic transition.
    expect(routes).toContain("'/:id/cancel'");
  });

  it('writes no lifecycle status outside the REQ-04 guard and no expiry automation', () => {
    const svc = readRepoFile('src', 'services', 'requirements.service.ts');
    // Creation initializes OPEN; REQ-07 cancellation writes CANCELLED only
    // through the REQ-04 authoritative guard. No other lifecycle status is written.
    expect(svc).toContain("status: 'OPEN'");
    expect(svc).toContain("status: 'CANCELLED'");
    expect(svc).toContain('canRequirementTransition');
    for (const status of ['PARTIALLY_FULFILLED', 'FULFILLED', 'EXPIRED']) {
      expect(svc).not.toContain(`status: '${status}'`);
    }
    // No lazy/automatic expiry mutation or worker wiring.
    expect(svc).not.toMatch(/cron|setInterval|setTimeout|schedule/i);
  });
});
