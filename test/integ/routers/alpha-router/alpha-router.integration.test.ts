/**
 * @jest-environment @uniswap/jest-environment-hardhat
 */

import { Currency, CurrencyAmount, TradeType, Percent, Ether } from '@uniswap/sdk-core';
import _ from 'lodash';
import {
  AlphaRouter,
  AlphaRouterConfig,
  USDC_MAINNET,
  USDT_MAINNET,
  WBTC_MAINNET,
  DAI_MAINNET,
  WRAPPED_NATIVE_CURRENCY,
  WETH9,
  parseAmount,
  ChainId,
  ID_TO_NETWORK_NAME,
  NATIVE_CURRENCY,
  CachingV3PoolProvider,
  V3PoolProvider,
  NodeJSCache,
  UniswapMulticallProvider,
  SwapRoute,
  V2PoolProvider,
  routeAmountsToString,
} from '../../../../src';
// MARK: end SOR imports

import '@uniswap/jest-environment-hardhat';

import { JsonRpcSigner } from '@ethersproject/providers';

import { MethodParameters, Trade } from '@uniswap/v3-sdk';
import { getBalance, getBalanceAndApprove } from '../../../test-util/getBalanceAndApprove';
import { BigNumber, providers } from 'ethers';
import { Protocol } from '@uniswap/router-sdk';
import { DEFAULT_ROUTING_CONFIG_BY_CHAIN } from '../../../../src/routers/alpha-router/config';
import { QuoteResponse, V2PoolInRoute, V3PoolInRoute } from '../../../test-util/schema';
import NodeCache from 'node-cache';

const SWAP_ROUTER_V2 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
const SLIPPAGE = new Percent(5, 10_000) // 5%

const checkQuoteToken = (
  before: CurrencyAmount<Currency>,
  after: CurrencyAmount<Currency>,
  tokensQuoted: CurrencyAmount<Currency>
) => {
  // Check which is bigger to support exactIn and exactOut
  const tokensSwapped = after.greaterThan(before) ? after.subtract(before) : before.subtract(after)

  const tokensDiff = tokensQuoted.greaterThan(tokensSwapped)
    ? tokensQuoted.subtract(tokensSwapped)
    : tokensSwapped.subtract(tokensQuoted)
  const percentDiff = tokensDiff.asFraction.divide(tokensQuoted.asFraction)
  /**
   * was this before new Fraction(parseInt(SLIPPAGE), 100))
   */
  expect(percentDiff.lessThan(SLIPPAGE)).toBe(true)
}

describe('alpha router integration', () => {

  let alice: JsonRpcSigner;
  jest.setTimeout(500 * 1000); // 500s

  let alphaRouter: AlphaRouter;

  /**
   * If we have to use more providers like these, we should consider epxosing them in the 
   * alpha router class.
   */
  const multicall2Provider = new UniswapMulticallProvider(ChainId.MAINNET, hardhat.provider, 375_000);

  const v3PoolProvider = new CachingV3PoolProvider(
    ChainId.MAINNET,
    new V3PoolProvider(ChainId.MAINNET, multicall2Provider),
    new NodeJSCache(new NodeCache({ stdTTL: 360, useClones: false }))
  );

  const v2PoolProvider = new V2PoolProvider(ChainId.MAINNET, multicall2Provider);

  const ROUTING_CONFIG: AlphaRouterConfig = {
    // @ts-ignore[TS7053] - complaining about switch being non exhaustive
    ...DEFAULT_ROUTING_CONFIG_BY_CHAIN[ChainId.MAINNET],
    protocols: [Protocol.V3, Protocol.V2]
  };

  const convertSwapDataToResponse = (amount: CurrencyAmount<Currency>, type: TradeType, swap: SwapRoute): QuoteResponse => {
    const {
      quote,
      quoteGasAdjusted,
      route,
      estimatedGasUsed,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
      gasPriceWei,
      methodParameters,
      blockNumber,
    } = swap

    const routeResponse: Array<V3PoolInRoute[] | V2PoolInRoute[]> = []

    for (const subRoute of route) {
      const { amount, quote, tokenPath } = subRoute

      /**
       * pull out amount & quote, check that sum of all subRoute == total quote at swap obejct level
       */

      if (subRoute.protocol == Protocol.V3) {
        const pools = subRoute.route.pools
        const curRoute: V3PoolInRoute[] = []
        for (let i = 0; i < pools.length; i++) {
          const nextPool = pools[i]
          const tokenIn = tokenPath[i]
          const tokenOut = tokenPath[i + 1]
          if (!nextPool || !tokenIn || !tokenOut) {
            console.log('undefined check failed')
            continue
          }; // TODO: @eric there are weird undefined checks here that are not present in routing API

          let edgeAmountIn = undefined
          if (i == 0) {
            edgeAmountIn = type == TradeType.EXACT_INPUT ? amount.quotient.toString() : quote.quotient.toString()
          }

          let edgeAmountOut = undefined
          if (i == pools.length - 1) {
            edgeAmountOut = type == TradeType.EXACT_INPUT ? quote.quotient.toString() : amount.quotient.toString()
          }

          curRoute.push({
            type: 'v3-pool',
            address: v3PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1, nextPool.fee).poolAddress,
            tokenIn: {
              chainId: tokenIn.chainId,
              decimals: tokenIn.decimals.toString(),
              address: tokenIn.address,
              symbol: tokenIn.symbol!,
            },
            tokenOut: {
              chainId: tokenOut.chainId,
              decimals: tokenOut.decimals.toString(),
              address: tokenOut.address,
              symbol: tokenOut.symbol!,
            },
            fee: nextPool.fee.toString(),
            liquidity: nextPool.liquidity.toString(),
            sqrtRatioX96: nextPool.sqrtRatioX96.toString(),
            tickCurrent: nextPool.tickCurrent.toString(),
            amountIn: edgeAmountIn,
            amountOut: edgeAmountOut,
          })
        }

        routeResponse.push(curRoute)
      } else if (subRoute.protocol == Protocol.V2) {
        const pools = subRoute.route.pairs
        const curRoute: V2PoolInRoute[] = []
        for (let i = 0; i < pools.length; i++) {
          const nextPool = pools[i]
          const tokenIn = tokenPath[i]
          const tokenOut = tokenPath[i + 1]
          if (!nextPool || !tokenIn || !tokenOut) {
            console.log('undefined check failed')
            continue
          }; // TODO: @eric there are weird undefined checks here that are not present in routing API

          let edgeAmountIn = undefined
          if (i == 0) {
            edgeAmountIn = type == TradeType.EXACT_INPUT ? amount.quotient.toString() : quote.quotient.toString()
          }

          let edgeAmountOut = undefined
          if (i == pools.length - 1) {
            edgeAmountOut = type == TradeType.EXACT_INPUT ? quote.quotient.toString() : amount.quotient.toString()
          }

          const reserve0 = nextPool.reserve0
          const reserve1 = nextPool.reserve1

          curRoute.push({
            type: 'v2-pool',
            address: v2PoolProvider.getPoolAddress(nextPool.token0, nextPool.token1).poolAddress,
            tokenIn: {
              chainId: tokenIn.chainId,
              decimals: tokenIn.decimals.toString(),
              address: tokenIn.address,
              symbol: tokenIn.symbol!,
            },
            tokenOut: {
              chainId: tokenOut.chainId,
              decimals: tokenOut.decimals.toString(),
              address: tokenOut.address,
              symbol: tokenOut.symbol!,
            },
            reserve0: {
              token: {
                chainId: reserve0.currency.wrapped.chainId,
                decimals: reserve0.currency.wrapped.decimals.toString(),
                address: reserve0.currency.wrapped.address,
                symbol: reserve0.currency.wrapped.symbol!,
              },
              quotient: reserve0.quotient.toString(),
            },
            reserve1: {
              token: {
                chainId: reserve1.currency.wrapped.chainId,
                decimals: reserve1.currency.wrapped.decimals.toString(),
                address: reserve1.currency.wrapped.address,
                symbol: reserve1.currency.wrapped.symbol!,
              },
              quotient: reserve1.quotient.toString(),
            },
            amountIn: edgeAmountIn,
            amountOut: edgeAmountOut,
          })
        }

        routeResponse.push(curRoute)
      }
    }

    return {
      methodParameters,
      blockNumber: blockNumber.toString(),
      amount: amount.quotient.toString(),
      amountDecimals: amount.toExact(),
      quote: quote.quotient.toString(),
      quoteDecimals: quote.toExact(),
      quoteGasAdjusted: quoteGasAdjusted.quotient.toString(),
      quoteGasAdjustedDecimals: quoteGasAdjusted.toExact(),
      gasUseEstimateQuote: estimatedGasUsedQuoteToken.quotient.toString(),
      gasUseEstimateQuoteDecimals: estimatedGasUsedQuoteToken.toExact(),
      gasUseEstimate: estimatedGasUsed.toString(),
      gasUseEstimateUSD: estimatedGasUsedUSD.toExact(),
      gasPriceWei: gasPriceWei.toString(),
      route: routeResponse,
      routeString: routeAmountsToString(route),
    }
  }

  const executeSwap = async (
    methodParameters: MethodParameters,
    currencyIn: Currency,
    currencyOut: Currency
  ): Promise<{
    tokenInAfter: CurrencyAmount<Currency>
    tokenInBefore: CurrencyAmount<Currency>
    tokenOutAfter: CurrencyAmount<Currency>
    tokenOutBefore: CurrencyAmount<Currency>
  }> => {
    console.log("params for executeSwap: ", currencyIn.symbol, currencyOut.symbol)
    expect(currencyIn.symbol).not.toBe(currencyOut.symbol);
    // await hardhat.approve(alice, SWAP_ROUTER_V2, currencyIn);
    const tokenInBefore = await getBalanceAndApprove(alice, SWAP_ROUTER_V2, currencyIn)
    // const tokenInBefore = await hardhat.getBalance(alice._address, currencyIn);
    const tokenOutBefore = await hardhat.getBalance(alice._address, currencyOut)

    const transaction = {
      data: methodParameters.calldata,
      to: SWAP_ROUTER_V2,
      value: BigNumber.from(methodParameters.value),
      from: alice._address,
      gasPrice: BigNumber.from(2000000000000),
      type: 1,
    }

    const transactionResponse: providers.TransactionResponse = await alice.sendTransaction(transaction)

    const receipt = await transactionResponse.wait()
    console.log(receipt);

    const tokenInAfter = await hardhat.getBalance(alice._address, currencyIn)
    const tokenOutAfter = await hardhat.getBalance(alice._address, currencyOut)

    console.log(
      {
        tokenInAfter: tokenInAfter.numerator,
        tokenInBefore: tokenInBefore.numerator,
        tokenOutAfter: tokenOutAfter.numerator,
        tokenOutBefore: tokenOutBefore.numerator,
      }
    )

    return {
      tokenInAfter,
      tokenInBefore,
      tokenOutAfter,
      tokenOutBefore,
    }
  }

  beforeAll(async () => {
    alice = hardhat.providers[0]!.getSigner()
    const aliceAddress = await alice.getAddress();
    expect(aliceAddress).toBe(alice._address);

    await hardhat.fork();

    await hardhat.fund(alice._address, [
      parseAmount('1000', USDC_MAINNET),
      parseAmount('1000', USDT_MAINNET),
      /**
       * TODO: need to add custom whale token list to fund from
       */
      // parseAmount('5000000', USDT_MAINNET),
      // parseAmount('10', WBTC_MAINNET),
      // // parseAmount('1000', UNI_MAIN),
      // parseAmount('4000', WETH9[1]),
      // parseAmount('5000000', DAI_MAINNET),
    ], [
      "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503", // Binance peg tokens
    ])

    const aliceUSDCBalance = await hardhat.getBalance(alice._address, USDC_MAINNET);
    expect(aliceUSDCBalance).toEqual(parseAmount('1000', USDC_MAINNET));
    const aliceUSDTBalance = await hardhat.getBalance(alice._address, USDT_MAINNET);
    expect(aliceUSDTBalance).toEqual(parseAmount('1000', USDT_MAINNET));

    alphaRouter = new AlphaRouter({
      chainId: 1,
      provider: hardhat.providers[0]!
    })
  })

  /**
   *  tests are 1:1 with routing api integ tests
   */
  for (const tradeType of [TradeType.EXACT_INPUT, TradeType.EXACT_OUTPUT]) {
    describe(`${ID_TO_NETWORK_NAME(1)} alpha - ${tradeType}`, () => {
      describe(`+ simulate swap`, () => {
        it.only('erc20 -> erc20', async () => {
          // ONLY ROUTES SHOULD BE FROM USDC-USDT 
          const amount = parseAmount('100', USDC_MAINNET);

          const swap = await alphaRouter.route(
            amount, // currentIn is nested in this
            USDT_MAINNET,
            tradeType,
            {
              recipient: alice._address,
              slippageTolerance: SLIPPAGE,
              deadline: 360,
            },
            {
              // check blocknumber - 10 thing
              ...ROUTING_CONFIG
            }
          );
          expect(swap).toBeDefined();
          expect(swap).not.toBeNull();

          // console.log(swap);
          if (!swap) {
            throw new Error("swap is null")
          }

          const {
            quote,
            routeString,
            amountDecimals,
            quoteDecimals,
            quoteGasAdjustedDecimals,
            methodParameters
          } = convertSwapDataToResponse(amount, tradeType, swap)

          console.log(methodParameters);

          expect(parseFloat(quoteDecimals)).toBeGreaterThan(90)
          expect(parseFloat(quoteDecimals)).toBeLessThan(110)

          if (tradeType == TradeType.EXACT_INPUT) {
            expect(parseFloat(quoteGasAdjustedDecimals)).toBeLessThanOrEqual(parseFloat(quoteDecimals))
          } else {
            expect(parseFloat(quoteGasAdjustedDecimals)).toBeGreaterThanOrEqual(parseFloat(quoteDecimals))
          }

          expect(methodParameters).not.toBeUndefined();

          console.log(routeString);

          // TODO: the methodParameters are malformed, so swaps are not executing correctly

          const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(
            methodParameters!,
            /**
             * Since amount is 100 USDC, if exactIN then route will be USDC -> USDT, so currencyIn == USDC, vice versa
             */
            tradeType == TradeType.EXACT_INPUT ? USDC_MAINNET : USDT_MAINNET,
            tradeType == TradeType.EXACT_INPUT ? USDT_MAINNET : USDC_MAINNET
          )

          if (tradeType == TradeType.EXACT_INPUT) {
            expect(tokenInBefore.subtract(tokenInAfter).toExact()).toEqual('100')
            checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(USDT_MAINNET, quote))
          } else {
            expect(tokenOutAfter.subtract(tokenOutBefore).toExact()).toEqual('100')
            checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote))
          }
        })

        it(`erc20 -> eth`, async () => {
          const amount = parseAmount(tradeType == TradeType.EXACT_INPUT ? '1000000' : '10', USDC_MAINNET);

          const swap = await alphaRouter.route(
            amount, // currentIn is nested in this
            WRAPPED_NATIVE_CURRENCY[1],
            tradeType,
            {
              recipient: alice._address,
              slippageTolerance: SLIPPAGE,
              deadline: 360,
            },
            {
              ...ROUTING_CONFIG
            }
          );
          expect(swap).toBeDefined();
          expect(swap).not.toBeNull();

          if (!swap) {
            throw new Error("swap is null")
          }

          const {
            quote,
            amountDecimals,
            quoteDecimals,
            quoteGasAdjustedDecimals,
            methodParameters
          } = convertSwapDataToResponse(amount, tradeType, swap)

          expect(methodParameters).not.toBeUndefined;

          if (tradeType == TradeType.EXACT_INPUT) {
            expect(parseFloat(quoteGasAdjustedDecimals)).toBeLessThanOrEqual(parseFloat(quoteDecimals))
          } else {
            expect(parseFloat(quoteGasAdjustedDecimals)).toBeGreaterThanOrEqual(parseFloat(quoteDecimals))
          }

        })

        it(`erc20 -> eth large trade`, async () => {
          // Trade of this size almost always results in splits.
          const amount = parseAmount(tradeType == TradeType.EXACT_INPUT ? '1000000' : '100', USDC_MAINNET);

          const swap = await alphaRouter.route(
            amount, // currentIn is nested in this
            WRAPPED_NATIVE_CURRENCY[1],
            tradeType,
            {
              recipient: alice._address,
              slippageTolerance: SLIPPAGE,
              deadline: 360,
            },
            {
              ...ROUTING_CONFIG
            }
          );
          expect(swap).toBeDefined();
          expect(swap).not.toBeNull();

          if (!swap) {
            throw new Error("swap is null")
          }

          const {
            quote,
            amountDecimals,
            quoteDecimals,
            quoteGasAdjustedDecimals,
            methodParameters,
            route,
            routeString
          } = convertSwapDataToResponse(amount, tradeType, swap)

          expect(methodParameters).not.toBeUndefined;

          console.log("roueString", routeString)

          expect(route).not.toBeUndefined

          const amountInEdgesTotal = _(route)
            .flatMap((route) => route[0]!)
            .filter((pool) => !!pool.amountIn)
            .map((pool) => BigNumber.from(pool.amountIn))
            .reduce((cur, total) => total.add(cur), BigNumber.from(0))
          const amountIn = BigNumber.from(quote)
          expect(amountIn.eq(amountInEdgesTotal))

          const amountOutEdgesTotal = _(route)
            .flatMap((route) => route[0]!)
            .filter((pool) => !!pool.amountOut)
            .map((pool) => BigNumber.from(pool.amountOut))
            .reduce((cur, total) => total.add(cur), BigNumber.from(0))
          const amountOut = BigNumber.from(quote)
          expect(amountOut.eq(amountOutEdgesTotal))

          // const { tokenInBefore, tokenInAfter, tokenOutBefore, tokenOutAfter } = await executeSwap(
          //   methodParameters!,
          //   USDC_MAINNET,
          //   Ether.onChain(1)
          // )

          // if (tradeType == TradeType.EXACT_INPUT) {
          //   expect(tokenInBefore.subtract(tokenInAfter).toExact()).toEqual('1000000')
          //   checkQuoteToken(tokenOutBefore, tokenOutAfter, CurrencyAmount.fromRawAmount(Ether.onChain(1), quote))
          // } else {
          //   // Hard to test ETH balance due to gas costs for approval and swap. Just check tokenIn changes
          //   checkQuoteToken(tokenInBefore, tokenInAfter, CurrencyAmount.fromRawAmount(USDC_MAINNET, quote))
          // }
        })
      })
    })
  }
})
