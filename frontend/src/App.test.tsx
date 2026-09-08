import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import App from './App';

test('renders FWRP shell', () => {
  render(<App />);
  expect(screen.getByText(/Food Waste Redistribution Platform/i)).toBeInTheDocument();
  expect(screen.getByText(/Frontend shell/i)).toBeInTheDocument();
});
