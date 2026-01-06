import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import getMyBalance from './utils/getMyBalance';
import runCopyBot from './services/runCopyBot';


const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    await connectDB();
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);
    console.log(`Target User Wallet balance is: ${await getMyBalance(PROXY_WALLET)}` )
    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);
    console.log(`My Wallet balance is: ${await getMyBalance(PROXY_WALLET)}` )
    const clobClient = await createClobClient();
    runCopyBot(clobClient);
};

main();
