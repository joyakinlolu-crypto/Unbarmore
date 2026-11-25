import { describe, expect, it } from 'vitest';
import { detectVoice, parseVideoCaption } from '../lib/videoCaption.js';

describe('parseVideoCaption — product photos + a line of text', () => {
  it.each([
    ['Cord lace 17500', 'Cord lace', 17500, null, 'english'],
    ['Cord lace, 17,500 for 5 yards', 'Cord lace', 17500, null, 'english'],
    ['Cord lace, 17,500 for 5 yards', 'Cord lace', 17500, null, 'english'],
    ['Ankara gown 15k delivery Lagos 2k', 'Ankara gown', 15000, 'Lagos 2k', 'english'],
    ['₦22,000 Swiss voile', 'Swiss voile', 22000, null, 'english'],
    ['Swiss voile ₦22,000 per yard', 'Swiss voile', 22000, null, 'english'],
    ['Gele 10k Yoruba', 'Gele', 10000, null, 'yoruba'],
    ['Cord lace 17,500 naira in pidgin', 'Cord lace', 17500, null, 'pidgin'],
    ['Aso oke 1.5m', 'Aso oke', 1500000, null, 'english'],
  ])('%s', (text, name, price, delivery, voice) => {
    expect(parseVideoCaption(text)).toEqual({ name, price, delivery, voice });
  });

  it('returns null when it cannot be sure (the caller then falls back to asking)', () => {
    for (const t of ['Cord lace', '17500', '', 'Ada paid 15k transfer', 'sent 20k', '5 yards', 'a'.repeat(300)]) expect(parseVideoCaption(t), t).toBeNull();
  });

  it('a quantity is not a price: "3 yards" never becomes ₦3', () => {
    expect(parseVideoCaption('Lace 3 yards 12k')?.price).toBe(12000);
  });
});

describe('detectVoice', () => {
  it('finds and removes the language word', () => {
    expect(detectVoice('Gele 10k in Yoruba')).toEqual({ voice: 'yoruba', rest: 'Gele 10k  ' });
    expect(detectVoice('Gele 10k').voice).toBeNull();
  });
});
