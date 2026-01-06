import { UserActivityInterface } from "../interfaces/User";

type Key = string;

export type AggregatedTrade = UserActivityInterface & {
  // add fields for aggregation diagnostics
  batchCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
};

const makeKey = (t: UserActivityInterface) =>
  `${t.asset}|${t.side}`; // optionally: + `|${t.conditionId}`

export class TradeAggregator {
  private buf = new Map<Key, AggregatedTrade>();

  add(t: UserActivityInterface) {
    const key = makeKey(t);

    // ignore non-trades
    if (t.type !== "TRADE") return;

    const existing = this.buf.get(key);
    if (!existing) {
      this.buf.set(key, {
        ...t,
        batchCount: 1,
        firstTimestamp: t.timestamp,
        lastTimestamp: t.timestamp,
      });
      return;
    }

    // Weighted average price by usdcSize for BUY, by size for SELL
    const wOld = t.side === "BUY" ? (existing.usdcSize ?? 0) : (existing.size ?? 0);
    const wNew = t.side === "BUY" ? (t.usdcSize ?? 0) : (t.size ?? 0);
    const wTot = wOld + wNew;

    const avgPrice =
      wTot > 0 ? ((existing.price ?? 0) * wOld + (t.price ?? 0) * wNew) / wTot : existing.price;

    existing.price = avgPrice;

    // Sum sizes
    existing.usdcSize = (existing.usdcSize ?? 0) + (t.usdcSize ?? 0);
    existing.size = (existing.size ?? 0) + (t.size ?? 0);

    // keep earliest txHash for keying/logging (optional)
    existing.transactionHash = existing.transactionHash ?? t.transactionHash;

    existing.batchCount += 1;
    existing.lastTimestamp = Math.max(existing.lastTimestamp, t.timestamp);
    this.buf.set(key, existing);
  }

  flush(): AggregatedTrade[] {
    const out = Array.from(this.buf.values());
    this.buf.clear();
    return out;
  }

  size() {
    return this.buf.size;
  }
}
