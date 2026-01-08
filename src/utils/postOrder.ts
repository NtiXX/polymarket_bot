import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;

const FEE_15M_BPS = 1000;
const FEE_DEFAULT_BPS = 0;

const MIN_BUY_NOTIONAL = 1; // $1

const RATIO_AMP = 30;



// In-memory retry tracking (no DB)
const retries = new Map<string, number>();

const tradeKey = (trade: UserActivityInterface) =>
  trade.transactionHash ??
  `${trade.timestamp}-${trade.conditionId}-${trade.side}-${trade.size}-${trade.price}-${trade.asset}`;

const markTried = (trade: UserActivityInterface) => {
  const key = tradeKey(trade);
  retries.set(key, (retries.get(key) ?? 0) + 1);
};

const markDone = (trade: UserActivityInterface) => {
  const key = tradeKey(trade);
  retries.set(key, RETRY_LIMIT);
};

const feeBpsFromTitle = (title?: string): number => {
  if (!title) return FEE_DEFAULT_BPS;

  const m = title.match(
    /(\d{1,2}:\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}:\d{2})\s*(AM|PM)/i
  );
  if (!m) return FEE_DEFAULT_BPS;

  const start = m[1] + m[2].toUpperCase(); // e.g. 10:00PM
  const end = m[3] + m[4].toUpperCase();   // e.g. 10:15PM

  const toMinutes = (t: string) => {
    // t like "10:00PM"
    const mt = t.match(/(\d{1,2}):(\d{2})(AM|PM)/i);
    if (!mt) return null;
    let h = parseInt(mt[1], 10);
    const mm = parseInt(mt[2], 10);
    const ap = mt[3].toUpperCase();

    if (h === 12) h = 0;
    if (ap === "PM") h += 12;
    return h * 60 + mm;
  };

  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return FEE_DEFAULT_BPS;

  // handle potential day wrap (rare, but safe)
  const diff = e >= s ? e - s : e + 24 * 60 - s;

  return diff === 15 ? FEE_15M_BPS : FEE_DEFAULT_BPS;
};

const getStartingBalances = () => ({
  my: Number((ENV as any).MY_STARTING_BALANCE ?? 0),
  user: Number((ENV as any).USER_STARTING_BALANCE ?? 0),
});

const getCopyRatio = (my_balance: number, user_balance: number, tradeNotional: number) => {
  
  const { my, user } = getStartingBalances();

  console.log(`My starting balance: ${my}--------User starting balance: ${user}`)

  if (Number.isFinite(my) && my > 0 && Number.isFinite(user) && user > 0) {
    return my / user; // NO amp here
  }

  // fallback (original approach)
  return (my_balance) / (user_balance + tradeNotional);
};

const postOrder = async (
  clobClient: ClobClient,
  condition: 'merge' | 'buy' | 'sell',
  my_position: UserPositionInterface | undefined,
  user_position: UserPositionInterface | undefined,
  trade: UserActivityInterface,
  my_balance: number,
  user_balance: number
) => {
    
  const key = tradeKey(trade);
  const alreadyTried = retries.get(key) ?? 0;
  if (alreadyTried >= RETRY_LIMIT) {
    console.log(`Skipping trade (retry limit reached): ${key}`);
    return;
  }

  // Buy strategy
  if (condition === 'buy') {
    console.log('Buy Strategy...');

    const ratio = getCopyRatio(my_balance, user_balance, trade.usdcSize) * RATIO_AMP;

    let remaining = trade.usdcSize * ratio;
    remaining = Math.min(remaining, my_balance);
    let retry = 0;

    while (remaining > 0 && retry < RETRY_LIMIT) {
      try {
        const orderBook = await clobClient.getOrderBook(trade.asset);

        if (!orderBook.asks || orderBook.asks.length === 0) {
          console.log('No asks found');
          markDone(trade);
          break;
        }

        const minPriceAsk = orderBook.asks.reduce((min, ask) =>
          parseFloat(ask.price) < parseFloat(min.price) ? ask : min
        , orderBook.asks[0]);

        console.log('Min price ask:', minPriceAsk);

        if (parseFloat(minPriceAsk.price) - 0.03 > trade.price) {
          console.log('Too big different price - do not copy');
          markDone(trade);
          break;
        }

        const askSize = parseFloat(minPriceAsk.size);
        const askPrice = parseFloat(minPriceAsk.price);

        // Cap by liquidity
        const maxSpendAtBestAsk = askSize * askPrice;
        const amount = remaining <= maxSpendAtBestAsk ? remaining : maxSpendAtBestAsk;

        if (amount < MIN_BUY_NOTIONAL) {
          console.log("============== Skipping BUY ===============")
          console.log(`$${amount} < $1 minimum after rounding`);
          console.log("===========================================")
          markDone(trade);
          break;
        }

        const feeRateBps = feeBpsFromTitle(trade.title);

        const order_args = {
          side: Side.BUY,
          tokenID: trade.asset,
          title: trade.title,
          amount: amount,       // USDC, 2 decimals, valid
          price: askPrice,              // price, 4 decimals
          feeRateBps: feeRateBps,
        };

        console.log("============== BUY TRADE ===============")
        console.log('Order args:', order_args);
        console.log("========================================")

        const signedOrder = await clobClient.createMarketOrder(order_args as any);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FAK);

        if (resp.success === true) {
          retry = 0;
          remaining -= amount; // subtract ACTUAL USDC spent
        } else {
          retry += 1;
          markTried(trade);
        }
      } catch (e) {
        retry += 1;
        markTried(trade);
        console.log('Error posting order: retrying...', e);
      }
    }

    if (retry >= RETRY_LIMIT) markDone(trade);
    return;
  }

  // Sell strategy
  if (condition === 'sell') {
    console.log('Sell Strategy...');

    let remaining = 0;

    if (!my_position) {
      console.log('No position to sell');
      markDone(trade);
      return;
    } else if (!user_position) {
      remaining = my_position.size;
    } else {
      const ratio = trade.size / (user_position.size + trade.size);
      console.log('ratio', ratio);
      remaining = my_position.size * ratio;
    }

    let retry = 0;

    while (remaining > 0 && retry < RETRY_LIMIT) {
      try {
        const orderBook = await clobClient.getOrderBook(trade.asset);

        if (!orderBook.bids || orderBook.bids.length === 0) {
          console.log('No bids found');
          markDone(trade);
          break;
        }

        const maxPriceBid = orderBook.bids.reduce((max, bid) =>
          parseFloat(bid.price) > parseFloat(max.price) ? bid : max
        , orderBook.bids[0]);

        console.log('Max price bid:', maxPriceBid);

        const bidSize = parseFloat(maxPriceBid.size);
        const bidPrice = parseFloat(maxPriceBid.price);

        const amount = remaining <= bidSize ? remaining : bidSize;

        const feeRateBps = feeBpsFromTitle(trade.title);

        const order_args = {
          side: Side.SELL,
          tokenID: trade.asset,
          title: trade.title,
          amount,
          price: bidPrice,
          feeRateBps: feeRateBps,
        };

        console.log("============== SELL TRADE ===============")
        console.log('Order args:', order_args);
        console.log("========================================")


        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

        if (resp.success === true) {
          retry = 0;
          console.log('Successfully posted order:', resp);
          remaining -= amount;
        } else {
          retry += 1;
          markTried(trade);
          console.log('Error posting order: retrying...', resp);
        }
      } catch (e) {
        retry += 1;
        markTried(trade);
        console.log('Error posting order: retrying...', e);
      }
    }

    if (retry >= RETRY_LIMIT) markDone(trade);
  }
};

export default postOrder;
