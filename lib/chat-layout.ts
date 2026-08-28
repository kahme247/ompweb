/** Maximum width of the centered chat column (conversation + composer).
 *  Kept in one place so the message list, notices shelf, empty state, and
 *  composer cannot drift apart. */
export const CHAT_COLUMN_MAX_WIDTH = 960;

/** Width of the minimap strip overlaid on the right edge of the chat scroll
 *  area (desktop only). Used to constrain the centered transcript column so
 *  it never extends under the minimap on narrow viewports. */
export const MINIMAP_WIDTH = 36;
