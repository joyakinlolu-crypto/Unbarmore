import { describe, expect, it } from 'vitest';
import { looksLikeBusinessName } from '../lib/businessName.js';

describe('looksLikeBusinessName', () => {
  it.each(['Ada Fabrics', 'AsoEwa Fabrics', 'Mama Tunde Stores', "Joy's Kitchen", 'ACENOOK ESTATE', 'Ọlá Fabrics', 'Bright Prints Ltd', 'HQ'])('accepts "%s"', (n) => expect(looksLikeBusinessName(n)).toBe(true));
  it.each(['Hi', 'hi!', 'Hello', 'hey', 'Good morning', 'ok', 'Sent', 'test', 'yes', 'No', 'oga', '123', '??', 'a', '', 'thanks'])('refuses "%s"', (n) => expect(looksLikeBusinessName(n)).toBe(false));
  it('refuses an essay', () => expect(looksLikeBusinessName('x'.repeat(200))).toBe(false));
});
