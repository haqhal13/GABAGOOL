import { ClobClient, OrderType, Side } from '@polymarket/clob-client';

/**
 * Test utility for CLOB client operations
 * This file can be used for testing CLOB API interactions
 */
const test = async (clobClient: ClobClient) => {
    const price = (
        await clobClient.getLastTradePrice(
            '7335630785946116680591336507965313288831710468958917901279210617913444658937'
        )
    ).price;
    console.log(price);
    const signedOrder = await clobClient.createOrder({
        side: Side.BUY,
        tokenID: '7335630785946116680591336507965313288831710468958917901279210617913444658937',
        size: 5,
        price,
    });
    const resp = await clobClient.postOrder(signedOrder, OrderType.GTC);
    console.log(resp);
};

export default test;
