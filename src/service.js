import {
  parseAccountInput,
  parseAuditInput,
  parseCancelInput,
  parseDisableInput,
  parseId,
  parseMarketStateInput,
  parseOrderInput,
  parsePageLimit,
  parsePublicationInput
} from './contracts.js';

export class ExchangeService {
  constructor(repository) {
    this.repository = repository;
  }

  createAccount(raw, options) {
    return this.repository.createAccount(parseAccountInput(raw), options);
  }

  transitionMarket(raw, options) {
    return this.repository.transitionMarket(parseMarketStateInput(raw), options);
  }

  disableAccount(accountId, raw, options) {
    return this.repository.disableAccount(parseDisableInput(raw, accountId), options);
  }

  submitOrder(raw, options) {
    return this.repository.submitOrder(parseOrderInput(raw), options);
  }

  cancelOrder(orderId, raw, options) {
    return this.repository.cancelOrder(parseCancelInput(raw, orderId), options);
  }

  publishMarketData(raw, options) {
    return this.repository.publishMarketData(parsePublicationInput(raw), options);
  }

  getPublicationPage(publicationId, section, cursor, limit) {
    return this.repository.getPublicationPage(
      parseId(publicationId, 'publicationId'), section, cursor, parsePageLimit(limit)
    );
  }

  runAudit(raw, options) {
    return this.repository.runAudit(parseAuditInput(raw), options);
  }

  getOrderEvidence(orderId) {
    return this.repository.getOrderEvidence(parseId(orderId, 'orderId'));
  }

  getState() {
    return this.repository.getState();
  }

  health() {
    return this.repository.health();
  }
}
