import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import getMyBalance from './utils/getMyBalance';
import runCopyBot from './services/runCopyBot';


const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    // await connectDB();
    console.log(`Target User Wallet addresss is: ${USER_ADDRESS}`);
    const userBalance = await getMyBalance(USER_ADDRESS)
    console.log(`Target User Wallet balance is: ${userBalance}` )
    console.log(`My Wallet addresss is: ${PROXY_WALLET}`);
    const myBalance = await getMyBalance(PROXY_WALLET)
    console.log(`My Wallet balance is: ${myBalance}` )

    ENV.MY_STARTING_BALANCE = myBalance;
    ENV.USER_STARTING_BALANCE = userBalance;

    const clobClient = await createClobClient();
    runCopyBot(clobClient, myBalance, userBalance);
};

main();
