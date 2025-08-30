import {
  payViaPaymentRequest,
  getPayment,
  deleteForwardingReputations,
  AuthenticatedLnd,
} from 'lightning';
import lnd from './connect';
import { logger, logTimeout, logOperationDuration } from '../logger';

const { parsePaymentRequest } = require('invoices');

interface PayViaPaymentRequestParams {
  lnd: AuthenticatedLnd;
  request: string;
  pathfinding_timeout: number;
  tokens?: number;
  max_fee?: number;
}

const payRequest = async ({ request, amount }: { request: string, amount: number }) => {
  const startTime = Date.now();
  const operationName = 'payRequest';
  // Use configurable pathfinding timeout, default to 60 seconds
  const pathfindingTimeout = parseInt(process.env.LN_PATHFINDING_TIMEOUT || '60000');

  try {
    const invoice = parsePaymentRequest({ request });
    if (!invoice) return false;
    // If the invoice is expired we return is_expired = true
    if (invoice.is_expired) return invoice;

    const maxRoutingFee = process.env.MAX_ROUTING_FEE;
    if (maxRoutingFee === undefined)
      throw new Error("Environment variable MAX_ROUTING_FEE is not defined");
    // We need to set a max fee amount
    const maxFee = amount * parseFloat(maxRoutingFee);
    const params : PayViaPaymentRequestParams = {
      lnd,
      request,
      pathfinding_timeout: pathfindingTimeout,
    };
    // If the invoice doesn't have amount we add it to the params
    if (!invoice.tokens) params.tokens = amount;
    // We set the max fee
    params.max_fee = maxFee;
    // If the amount is small we use a different max routing fee
    if (amount <= 100) params.max_fee = amount * 0.1;

    // Delete all routing reputations to clear pathfinding memory
    await deleteForwardingReputations({ lnd });

    logger.info(`Starting payment for ${amount} sats with ${pathfindingTimeout}ms timeout`);
    const payment = await payViaPaymentRequest(params);
    
    logOperationDuration(operationName, startTime, true);
    return payment;
  } catch (error: any) {
    const errorMessage = error.toString();
    
    logOperationDuration(operationName, startTime, false);
    
    // Enhanced error handling for different timeout scenarios
    if (errorMessage.includes('TimeoutError') || errorMessage.includes('timed out')) {
      logTimeout('payRequest', pathfindingTimeout, error);
      logger.error(`payRequest timeout after ${pathfindingTimeout}ms: ${errorMessage}`);
      return { error: 'TIMEOUT', message: errorMessage };
    }
    
    if (errorMessage.includes('UnknownPaymentHash') || errorMessage.includes('PaymentPathfindingFailedToFindPossibleRoute')) {
      logger.error(`payRequest routing failed: ${errorMessage}`);
      return { error: 'ROUTING_FAILED', message: errorMessage };
    }
    
    if (errorMessage.includes('InsufficientBalance')) {
      logger.error(`payRequest insufficient balance: ${errorMessage}`);
      return { error: 'INSUFFICIENT_BALANCE', message: errorMessage };
    }
    
    logger.error(`payRequest unexpected error: ${errorMessage}`);
    return { error: 'UNKNOWN', message: errorMessage };
  }
};

const isPendingPayment = async (request: string) => {
  try {
    const { id } = parsePaymentRequest({ request });
    const { is_pending } = await getPayment({ lnd, id });

    return !!is_pending;
  } catch (error: any) {
    const message = error.toString();
    logger.error(`isPendingPayment catch error: ${message}`);
    return false;
  }
};

export {
  payRequest,
  isPendingPayment,
};
