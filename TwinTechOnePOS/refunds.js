/* Refund business rules. Amounts are integer centavos; original sales stay immutable. */
window.OnePOSRefunds = (() => {
  const forSale = (data, id) => (data.refunds || []).filter(r => r.saleId === id);
  function remaining(data, sale, index) {
    return sale.items[index].quantity - forSale(data, sale.id).reduce((sum, r) => sum + r.items.filter(i => i.lineIndex === index).reduce((n, i) => n + i.quantity, 0), 0);
  }
  function status(data, sale) {
    const records = forSale(data, sale.id);
    if (records.some(r => r.type === 'VOID')) return 'Voided';
    if (!records.length) return 'Completed';
    return sale.items.every((_, index) => remaining(data, sale, index) === 0) ? 'Refunded' : 'Partially refunded';
  }
  function expected(data, register) { return window.OnePOSRegister.totals(data, register).expected; }
  function quote(data, sale, quantities, restock, type = 'REFUND') {
    if (!['REFUND', 'VOID'].includes(type)) throw new Error('Invalid refund type.');
    if (type === 'VOID' && forSale(data, sale.id).length) throw new Error('A partially refunded sale cannot be voided. Refund its remaining items instead.');
    const basis = sale.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    let cumulative = 0;
    const items = [];
    sale.items.forEach((item, index) => {
      const before = basis ? Math.round(cumulative * sale.total / basis) : 0;
      cumulative += item.price * item.quantity;
      const lineTotal = basis ? Math.round(cumulative * sale.total / basis) - before : 0;
      const available = remaining(data, sale, index);
      const quantity = type === 'VOID' ? available : Number(quantities[index] || 0);
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > available) throw new Error('Refund quantity exceeds remaining items.');
      if (!quantity) return;
      const returned = item.quantity - available;
      const total = Math.round(lineTotal * (returned + quantity) / item.quantity) - Math.round(lineTotal * returned / item.quantity);
      const putBack = Boolean(restock[index]);
      if (putBack && !data.products.some(p => p.id === item.productId)) throw new Error('A deleted product cannot be restocked. Uncheck its stock-return option.');
      items.push({lineIndex: index, productId: item.productId, name: item.name, quantity, total, cost: item.cost || 0, restock: putBack});
    });
    if (!items.length) throw new Error('Select at least one remaining item.');
    const total = items.reduce((sum, i) => sum + i.total, 0);
    const previous = forSale(data, sale.id).reduce((sum, r) => sum + r.total, 0);
    const net = sale.total ? Math.round((previous + total) * sale.net / sale.total) - Math.round(previous * sale.net / sale.total) : 0;
    return {items, total, net, vat: total - net};
  }
  function apply(data, saleId, quantities, restock, reason, type, id, createdAt) {
    if ((data.refunds || []).some(r => r.id === id)) throw new Error('This refund was already recorded.');
    const sale = data.sales.find(s => s.id === saleId);
    if (!sale) throw new Error('Sale not found.');
    const register = data.registers.find(r => !r.closedAt);
    if (!register) throw new Error('Open a register before paying a cash refund.');
    if (sale.paymentMethod !== 'Cash') throw new Error('Only cash refunds are supported.');
    reason = String(reason || '').trim();
    if (!reason || reason.length > 300) throw new Error('Enter a reason of 1 to 300 characters.');
    const result = quote(data, sale, quantities, restock, type);
    if (result.total > expected(data, register)) throw new Error('The open register does not have enough expected cash for this refund.');
    const refund = {id, number: 'R' + String((data.refunds || []).length + 1).padStart(6, '0'), saleId, saleNumber: sale.number, registerId: register.id, cashier: data.settings.cashier, store: sale.store, address: sale.address || data.settings.address || '', tin: sale.tin || '', createdAt, reason, type, ...result};
    for (const item of result.items) if (item.restock) {
      const product = data.products.find(p => p.id === item.productId);
      if (!Number.isSafeInteger(product.stock + item.quantity)) throw new Error('Stock quantity is too large.');
      product.stock += item.quantity;
      data.movements.push({id: id + '-' + item.lineIndex, productId: item.productId, change: item.quantity, reason: `${type === 'VOID' ? 'Void' : 'Refund'} ${refund.number}: ${reason}`, createdAt});
    }
    (data.refunds ||= []).push(refund);
    return refund.id;
  }
  return {forSale, remaining, status, expected, quote, apply};
})();
