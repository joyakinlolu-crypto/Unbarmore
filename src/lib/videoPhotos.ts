/** How many of the owner's photos go into a video. Every photo is cleaned by the paid image model (~₦60), so this is the main cost dial. */
export function photosForVideo<T>(photos: T[], mini: boolean, limits: { full: number; mini: number }): T[] {
  return photos.slice(0, Math.max(1, mini ? limits.mini : limits.full));
}
