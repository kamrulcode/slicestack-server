import { collections } from "../config/db.js";

/**
 * Count documents per day for the last seven calendar days (UTC). Used by the
 * dashboard charts so the UI never shows invented series data.
 */
export async function weeklyCounts(filter, dateField = "createdAt") {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 6);

  const rows = await collections.orders
    .aggregate([
      { $match: { ...filter, [dateField]: { $gte: start } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}` } },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const counts = new Map(rows.map((row) => [row._id, row.count]));
  const series = [];

  for (let index = 0; index < 7; index += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10);
    series.push({ date: key, count: counts.get(key) ?? 0 });
  }

  return series;
}
