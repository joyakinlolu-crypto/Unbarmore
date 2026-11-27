import { describe, expect, it } from 'vitest';
import { looksLikeBusinessName } from '../lib/businessName.js';

describe('looksLikeBusinessName', () => {
  it.each(['Ada Fabrics', 'AsoEwa Fabrics', 'Mama Tunde Stores', "Joy's Kitchen", 'ACENOOK ESTATE', 'Ọlá Fabrics', 'Bright Prints Ltd', 'HQ'])('accepts "%s"', (n) => expect(looksLikeBusinessName(n)).toBe(true));
  it.each(['Hi', 'hi!', 'Hello', 'hey', 'Good morning', 'ok', 'Sent', 'test', 'yes', 'No', 'oga', '123', '??', 'a', '', 'thanks'])('refuses "%s"', (n) => expect(looksLikeBusinessName(n)).toBe(false));
  it('refuses an essay', () => expect(looksLikeBusinessName('x'.repeat(200))).toBe(false));
});

import { extractBusinessName } from '../lib/businessName.js';
describe('extractBusinessName: pull the name out of a sentence', () => {
  it.each([
    ['Ada Fabrics', 'Ada Fabrics'],
    ['My business Name is TeweTegbo. We deal with herbal Remedies for all forms of health issues.', 'TeweTegbo'],
    ['my shop is Mama Tunde Stores, we sell lace and ankara', 'Mama Tunde Stores'],
    ["It's Bright Prints", 'Bright Prints'],
    ['Business name: Joy’s Kitchen', 'Joy’s Kitchen'],
    ['Hello, my business is Ola Beauty Hub', 'Ola Beauty Hub'],
    ['I am Tunde Autos - spare parts', 'Tunde Autos'],
    ['"Gold Crown Bakery"', 'Gold Crown Bakery'],
  ])('%s → %s', (input, name) => expect(extractBusinessName(input)).toBe(name));
  it.each(['Hello', 'We deal in lace and ankara', 'I sell shoes', 'ok', '', 'x'.repeat(120), 'My business sells herbal remedies for all kinds of health issues in Ibadan and beyond'])('cannot tell, so asks again: %s', (input) => expect(extractBusinessName(input)).toBeNull());
});
