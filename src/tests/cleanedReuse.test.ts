import { describe, expect, it } from 'vitest';
import { reusableCleaned } from '../lib/cleanedReuse.js';

const raw = ['biz/a.jpg', 'biz/b.jpg', 'biz/c.jpg'];
describe('reusableCleaned (remakes reuse already-cleaned photos, never a wrong one)', () => {
  it('same uploaded photos → reuse the cleaned files', () => {
    expect(reusableCleaned(raw, [{ raw, cleaned: ['biz/v1-0.png', 'biz/v1-1.png', ''] }])).toEqual(['biz/v1-0.png', 'biz/v1-1.png', '']);
  });
  it('different photos (new upload) → nothing reused', () => {
    expect(reusableCleaned(['biz/x.jpg', 'biz/y.jpg'], [{ raw, cleaned: ['biz/v1-0.png'] }])).toEqual([]);
  });
  it('same count but a different file in the list → nothing reused', () => {
    expect(reusableCleaned(raw, [{ raw: ['biz/a.jpg', 'biz/b.jpg', 'biz/OTHER.jpg'], cleaned: ['biz/v1-0.png'] }])).toEqual([]);
  });
  it('a cleaned file that is NOT at its own position (an old compact list) is never trusted', () => {
    expect(reusableCleaned(raw, [{ raw, cleaned: ['biz/v1-1.png'] }])).toEqual([]);   // photo 1 listed at position 0
  });
  it('an earlier video where nothing was cleaned → nothing to reuse', () => {
    expect(reusableCleaned(raw, [{ raw, cleaned: ['', '', ''] }])).toEqual([]);
  });
  it('picks the first good candidate (most recent first)', () => {
    expect(reusableCleaned(raw, [{ raw: ['z'], cleaned: ['biz/v3-0.png'] }, { raw, cleaned: ['biz/v2-0.png'] }])).toEqual(['biz/v2-0.png']);
  });
});
