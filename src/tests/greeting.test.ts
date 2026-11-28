import { describe, expect, it } from 'vitest';
import { isGreeting, welcomeLines } from '../lib/greeting.js';

describe('greeting', () => {
  it('recognises plain hellos in English, Pidgin, Yoruba and Hausa', () => {
    for (const g of ['hi', 'Hello', 'HELLO!!', 'hey', 'good morning', 'Good evening.', 'how far', 'e kaaro', 'ina kwana', 'how you dey']) expect(isGreeting(g)).toBe(true);
  });
  it('does not swallow a real message that starts with a greeting', () => {
    for (const g of ['hi sold 2 lace 50k', 'hello who owes me', 'good morning I need a receipt', 'high price', 'hiya customer']) expect(isGreeting(g)).toBe(false);
  });
  it('welcome is short, names the shop, and never names a city', () => {
    const text = welcomeLines('Ada Fabrics').join('\n');
    expect(text).toMatch(/Ada Fabrics/);
    expect(text.length).toBeLessThan(500);
    expect(text).not.toMatch(/Lagos|Abuja|Kano|Port Harcourt/i);
  });
});
