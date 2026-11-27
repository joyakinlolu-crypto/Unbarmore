import { describe, expect, it } from 'vitest';
import { photosForVideo } from '../lib/videoPhotos.js';

describe('photosForVideo: the main AI-cost dial', () => {
  const five = ['a', 'b', 'c', 'd', 'e'];
  it('full video uses up to the full limit', () => expect(photosForVideo(five, false, { full: 3, mini: 2 })).toEqual(['a', 'b', 'c']));
  it('preview video uses fewer', () => expect(photosForVideo(five, true, { full: 3, mini: 2 })).toEqual(['a', 'b']));
  it('never drops below one photo, never invents photos', () => {
    expect(photosForVideo(['a'], false, { full: 3, mini: 2 })).toEqual(['a']);
    expect(photosForVideo(five, true, { full: 3, mini: 0 })).toEqual(['a']);
  });
});
