import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;

const TAKER_FEE_BPS = 1000;

const MIN_BUY_NOTIONAL = 1; // $1

const RATIO_AMP = 40;

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

  // Merge strategy
  if (condition === 'merge') {
    console.log('Merging Strategy...');

    if (!my_position) {
      console.log('my_position is undefined');
      markDone(trade);
      return;
    }

    let remaining = my_position.size;
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

        const maxSize = parseFloat(maxPriceBid.size);
        const price = parseFloat(maxPriceBid.price);

        const amount = remaining <= maxSize ? remaining : maxSize;

        const order_args = {
          side: Side.SELL,
          tokenID: my_position.asset,
          amount,
          price,
          feeRateBps: TAKER_FEE_BPS,
        };

        console.log('Order args:', order_args);

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.GTC);

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
    return;
  }



  // Buy strategy
  if (condition === 'buy') {
    console.log('Buy Strategy...');

    const ratio = my_balance * RATIO_AMP / (user_balance + trade.usdcSize);
    console.log('ratio', ratio);

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

        if (parseFloat(minPriceAsk.price) - 0.1 > trade.price) {
          console.log('Too big different price - do not copy');
          markDone(trade);
          break;
        }

        const askSize = parseFloat(minPriceAsk.size);
        const askPrice = parseFloat(minPriceAsk.price);

        // Cap by available liquidity at best ask
        const maxSpendAtBestAsk = askSize * askPrice;
        const amount = remaining <= maxSpendAtBestAsk ? remaining : maxSpendAtBestAsk;

        const roundTo = (value: number, decimals: number) =>
          Math.floor(value * 10 ** decimals) / 10 ** decimals;

        // BUY rules
        const roundedAmountUSDC = roundTo(amount, 2);   // takerAmount
        const roundedPrice      = roundTo(askPrice, 4); // price precision safety

        const order_args = {
          side: Side.BUY,
          tokenID: trade.asset,
          amount: roundedAmountUSDC,
          price: roundedPrice,
          feeRateBps: TAKER_FEE_BPS,
        };

        console.log('Order args:', order_args);

        if (remaining < MIN_BUY_NOTIONAL) {
          console.log(`Skipping BUY: remaining ${remaining} < $1 minimum`);
          markDone(trade);
          break;
        }

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.GTC);

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

        const order_args = {
          side: Side.SELL,
          tokenID: trade.asset,
          amount,
          price: bidPrice,
          feeRateBps: TAKER_FEE_BPS,
        };

        console.log('Order args:', order_args);

        const signedOrder = await clobClient.createMarketOrder(order_args);
        const resp = await clobClient.postOrder(signedOrder, OrderType.GTC);

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
