import type { ObjectId } from 'mongodb';

/**
 * One place on a seat plan, seen from above, front row first: a seat number, the driver, the door, or nothing (the
 * aisle, the space beside the driver). Columns are read left to right; a column with no seat is drawn narrow.
 */
export type SeatCell = number | 'driver' | 'door' | null;
export type SeatLayout = SeatCell[][];

/** A vehicle of the catalog, seeded for every organization: picked when creating a departure, its plan shown first. */
export type VehicleModelDoc = {
  _id: ObjectId;
  /** Stable: "bus-53", "minibus-15". */
  key: string;
  label: string;
  kind: 'bus' | 'minibus';
  /** Seats sold (the driver's is not one). */
  capacity: number;
  layout: SeatLayout;
  sortOrder: number;
  createdAt: Date;
};

/**
 * The big buses: 2 seats on the right of the driver, rows of 2 + aisle + 2 (numbered left pair first), a row with the
 * door on the right, 5 more rows (right pair first), then the back bench of 5 across the aisle. 29 + 4 × `rowsBeforeDoor`
 * seats: 4 → 45, 5 → 49, 6 → 53, 7 → 57.
 */
export function busLayout(rowsBeforeDoor: number): SeatLayout {
  const rows: SeatLayout = [['driver', null, null, 2, 1]];
  let n = 3;
  for (let r = 0; r < rowsBeforeDoor; r++, n += 4) rows.push([n + 1, n, null, n + 3, n + 2]);
  rows.push([n + 1, n, null, 'door', 'door']);
  n += 2;
  for (let r = 0; r < 5; r++, n += 4) rows.push([n + 3, n + 2, null, n + 1, n]);
  rows.push([n + 4, n + 3, n + 2, n + 1, n]);
  return rows;
}

/**
 * The « Cheikhou Cherif » minibuses: the driver at the front left, rows of 3 numbered right to left, the sliding door
 * on the right of the 2nd and 3rd rows. 14 places: one seat beside the driver (13 sold); 15 places: two (14 sold).
 */
export function minibusLayout(frontSeats: 1 | 2): SeatLayout {
  const rows: SeatLayout = [frontSeats === 1 ? ['driver', null, 1, null] : ['driver', 2, 1, null]];
  let n = frontSeats + 1;
  for (let r = 0; r < 4; r++, n += 3) rows.push([n + 2, n + 1, n, r < 2 ? 'door' : null]);
  return rows;
}

export const seatsOf = (layout: SeatLayout) => layout.flat().filter((c): c is number => typeof c === 'number');

export const VEHICLE_MODELS: Omit<VehicleModelDoc, '_id' | 'createdAt'>[] = [
  { key: 'minibus-14', label: 'Cheikhou Cherif 14 places', kind: 'minibus', layout: minibusLayout(1) },
  { key: 'minibus-15', label: 'Cheikhou Cherif 15 places', kind: 'minibus', layout: minibusLayout(2) },
  { key: 'bus-45', label: 'Bus 45 places', kind: 'bus', layout: busLayout(4) },
  { key: 'bus-49', label: 'Bus 49 places', kind: 'bus', layout: busLayout(5) },
  { key: 'bus-53', label: 'Bus 53 places', kind: 'bus', layout: busLayout(6) },
  { key: 'bus-57', label: 'Bus 57 places', kind: 'bus', layout: busLayout(7) },
].map((m, i) => ({ ...m, kind: m.kind as 'bus' | 'minibus', capacity: seatsOf(m.layout).length, sortOrder: i }));

/**
 * Where each seat sits on a plan: by the window (first or last column with seats), in the middle of an odd row (the
 * back bench's aisle seat, a minibus's middle seat), or on the aisle.
 */
export function seatKinds(layout: SeatLayout) {
  const width = Math.max(...layout.map((r) => r.length));
  const seatCols = Array.from({ length: width }, (_, c) => c).filter((c) => layout.some((r) => typeof r[c] === 'number'));
  const middle = seatCols.length % 2 === 1 ? seatCols[(seatCols.length - 1) / 2] : -1;
  const kinds = new Map<number, 'window' | 'aisle' | 'middle'>();
  for (const row of layout) {
    row.forEach((cell, c) => {
      if (typeof cell !== 'number') return;
      kinds.set(cell, c === seatCols[0] || c === seatCols[seatCols.length - 1] ? 'window' : c === middle ? 'middle' : 'aisle');
    });
  }
  return kinds;
}
