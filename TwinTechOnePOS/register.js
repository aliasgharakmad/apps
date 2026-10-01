/* Register cash accounting, shared by cash movements, refunds, and closing. */
window.OnePOSRegister = (() => {
  function totals(data, register) {
    const sum = rows => rows.reduce((n, row) => n + row.total, 0);
    const movements = (data.cashMovements || []).filter(m => m.registerId === register.id);
    const sales = sum(data.sales.filter(s => s.registerId === register.id));
    const refunds = sum((data.refunds || []).filter(r => r.registerId === register.id));
    const cashIn = movements.filter(m => m.type === 'IN').reduce((n, m) => n + m.amount, 0);
    const cashOut = movements.filter(m => m.type === 'OUT').reduce((n, m) => n + m.amount, 0);
    return {opening: register.opening, sales, refunds, cashIn, cashOut, expected: register.opening + sales - refunds + cashIn - cashOut};
  }
  function record(data, registerId, type, amount, reason, id, createdAt) {
    const register = data.registers.find(r => r.id === registerId && !r.closedAt);
    if (!register) throw new Error('This register is no longer open.');
    if (!['IN', 'OUT'].includes(type)) throw new Error('Invalid cash movement.');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
    reason = String(reason || '').trim();
    if (!reason || reason.length > 300) throw new Error('Enter a reason of 1 to 300 characters.');
    if ((data.cashMovements || []).some(m => m.id === id)) throw new Error('This cash movement was already recorded.');
    if (type === 'OUT' && amount > totals(data, register).expected) throw new Error('Cash out exceeds the expected cash in this register.');
    (data.cashMovements ||= []).push({id, registerId, type, amount, reason, cashier: data.settings.cashier, createdAt});
  }
  return {totals, record};
})();
