/**
 * Which scanned passport the "Passport OCR" button should reach for.
 *
 * Scans are stored against a reservation with a `guest_index`: 0 is the main
 * guest, 1 and up are the accompanying guests, and the index is always the
 * party member's `display_order` minus one. Accompanying guests occupy
 * display_order 2, 3 and 4.
 *
 * The subtle part is the NEW guest. The server does not append — it hands out
 * the first FREE slot in [2,3,4], so a slot freed by a removed guest is reused.
 * The picker therefore has to predict the same slot the server will assign;
 * counting the guests already present gives the right answer only while the
 * slots happen to be contiguous, and the wrong one forever after a removal.
 *
 * Getting it wrong is not a cosmetic bug: the button silently loads a DIFFERENT
 * guest's passport into the form being filled, so one person is checked in
 * twice under two names and the other is never recorded at all.
 */

/** Accompanying guests live in these display_order slots, in this order. */
export const ACCOMPANYING_SLOTS = [2, 3, 4] as const;

/** The slot the server will give the next accompanying guest, or null if full. */
export function nextAccompanyingDisplayOrder(occupied: readonly number[]): number | null {
  for (const slot of ACCOMPANYING_SLOTS) {
    if (!occupied.includes(slot)) return slot;
  }
  return null;
}

export function passportOcrGuestIndex(input: {
  /** The party member being edited, if any. Null when adding a new guest. */
  memberDisplayOrder?: number | null;
  /** display_order values already taken by accompanying guests on this booking. */
  occupiedAccompanyingSlots: readonly number[];
}): number {
  const slot =
    input.memberDisplayOrder ??
    nextAccompanyingDisplayOrder(input.occupiedAccompanyingSlots) ??
    ACCOMPANYING_SLOTS[ACCOMPANYING_SLOTS.length - 1];

  // Never 0: that is the main guest's scan, and an accompanying form filled
  // from it would overwrite the room's primary guest with a copy of themselves.
  return Math.max(1, slot - 1);
}
