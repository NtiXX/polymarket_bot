import moment from "moment";
import { ClobClient } from "@polymarket/clob-client";

import { ENV } from "../config/env";
import { UserActivityInterface, UserPositionInterface } from "../interfaces/User";
import fetchData from "../utils/fetchData";
import spinner from "../utils/spinner";
import getMyBalance from "../utils/getMyBalance";
import postOrder from "../utils/postOrder";
import { TradeAggregator, AggregatedTrade } from "../utils/tradeAggregator";

const USER_ADDRESS = ENV.USER_ADDRESS; // target trader
const PROXY_WALLET = ENV.PROXY_WALLET; // your wallet
const FETCH_INTERVAL = ENV.FETCH_INTERVAL; // seconds
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP; // hours
const RETRY_LIMIT = ENV.RETRY_LIMIT;

const BATCH_WINDOW_MS = 900; // collect “5-6 events per trade” into 1 order

if (!USER_ADDRESS) throw new Error("USER_ADDRESS is not defined");
if (!PROXY_WALLET) throw new Error("PROXY_WALLET is not defined");

type TradeKey = string;

const activityKey = (a: UserActivityInterface): TradeKey =>
  a.transactionHash ??
  `${a.timestamp}-${a.conditionId}-${a.side}-${a.size}-${a.price}-${a.asset}`;

const seenThisRun = new Set<TradeKey>();
const retries = new Map<TradeKey, number>();
let primed = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetchTargetTrades = async (): Promise<UserActivityInterface[]> => {
  const user_activities: UserActivityInterface[] = await fetchData(
    `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}&limit=100&offset=0`
  );

  const now = Math.floor(moment().valueOf() / 1000);

  return user_activities
    .filter((a) => a.type === "TRADE")
    .filter((a) => (a.timestamp ?? 0) + TOO_OLD_TIMESTAMP * 60 * 60 > now)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
};

const doTrading = async (clobClient: ClobClient, trades: AggregatedTrade[]) => {
  for (const trade of trades) {
    // One aggregated trade is a “synthetic” trade. Use a stable key.
    const key =
      trade.transactionHash ??
      `${trade.firstTimestamp}-${trade.lastTimestamp}-${trade.side}-${trade.asset}`;

    const tries = retries.get(key) ?? 0;
    if (tries >= RETRY_LIMIT) continue;

    try {
      console.log("============== FETCHED ===============")
      console.log(`Aggregated trade x${trade.batchCount}:`, {
        side: trade.side,
        asset: trade.asset,
        conditionId: trade.conditionId,
        usdcSize: trade.usdcSize,
        size: trade.size,
        outcome: trade.outcome,
        avgPrice: trade.price,
        firstTimestamp: trade.firstTimestamp,
        lastTimestamp: trade.lastTimestamp,
      });
      console.log("======================================")

      const my_positions: UserPositionInterface[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
      );
      const user_positions: UserPositionInterface[] = await fetchData(
        `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
      );

      const my_position = my_positions.find((p) => p.conditionId === trade.conditionId);
      const user_position = user_positions.find((p) => p.conditionId === trade.conditionId);

      const my_balance = await getMyBalance(PROXY_WALLET);
      const user_balance = await getMyBalance(USER_ADDRESS);

      console.log("My current balance:", my_balance);
      console.log("User current balance:", user_balance);

      if (trade.side === "BUY") {
        if (user_position && my_position && my_position.asset !== trade.asset) {
          await postOrder(clobClient, "merge", my_position, user_position, trade, my_balance, user_balance);
        } else {
          await postOrder(clobClient, "buy", my_position, user_position, trade, my_balance, user_balance);
        }
      } else if (trade.side === "SELL") {
        await postOrder(clobClient, "sell", my_position, user_position, trade, my_balance, user_balance);
      } else {
        console.log("Not supported trade side:", trade.side);
      }

      retries.set(key, RETRY_LIMIT);
    } catch (err) {
      retries.set(key, tries + 1);
      console.error(`Failed copying aggregated trade (attempt ${tries + 1}/${RETRY_LIMIT})`, err);
    }
  }
};

const runCopyBot = async (clobClient: ClobClient) => {
  console.log("Copy bot running. Poll interval:", FETCH_INTERVAL, "seconds");

  while (true) {
    try {
      const trades = await fetchTargetTrades();

      // Prime: mark current history as seen, do not execute.
      if (!primed) {
        for (const t of trades) seenThisRun.add(activityKey(t));
        primed = true;
        console.log(`Primed with ${trades.length} recent trades. Will execute only NEW trades from now on.`);
        spinner.start("Waiting for new trades");
        await sleep(FETCH_INTERVAL * 1000);
        continue;
      }

      // Only trades not seen since bot start
      const newTrades = trades.filter((t) => {
        const k = activityKey(t);
        if (seenThisRun.has(k)) return false;
        seenThisRun.add(k);
        return true;
      });

      if (newTrades.length === 0) {
        spinner.start("Waiting for new trades");
        await sleep(FETCH_INTERVAL * 1000);
        continue;
      }

      spinner.stop();
      console.log(`💥 ${newTrades.length} new trade event(s) detected. Aggregating...`);

      // Aggregate everything that arrives within the short batch window
      const agg = new TradeAggregator();
      for (const t of newTrades) agg.add(t);

      const t0 = Date.now();
      while (Date.now() - t0 < BATCH_WINDOW_MS) {
        await sleep(150);

        const more = await fetchTargetTrades();
        const moreNew = more.filter((t) => {
          const k = activityKey(t);
          if (seenThisRun.has(k)) return false;
          seenThisRun.add(k);
          return true;
        });

        for (const t of moreNew) agg.add(t);
      }

      const aggregated = agg.flush();
      console.log(`✅ Aggregated into ${aggregated.length} trade(s). Executing...`);

      await doTrading(clobClient, aggregated);
    } catch (err) {
      spinner.stop();
      console.error("runCopyBot loop error:", err);
    }

    await sleep(FETCH_INTERVAL * 500);
  }
};

export default runCopyBot;
