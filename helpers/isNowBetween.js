export default function isNowBetween(start, end) {
  const toMinutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const startMin = toMinutes(start);
  const endMin = toMinutes(end);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin <= endMin) {
    // e.g. 09:00–17:00
    return nowMin >= startMin && nowMin < endMin;
  } else {
    // e.g. 22:00–04:00 (crosses midnight)
    return nowMin >= startMin || nowMin < endMin;
  }
}
