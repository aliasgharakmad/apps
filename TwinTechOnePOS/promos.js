/* Product promo schedules use Philippine calendar dates, inclusive of the end date. */
window.OnePOSPromos = (() => {
  const today = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
  function activeRate(product, day = today()) {
    if ((product.promoStart && day < product.promoStart) || (product.promoEnd && day > product.promoEnd)) return 0;
    return product.promoPercent || 0;
  }
  function expired(product, day = today()) { return Boolean(product.promoEnd && day > product.promoEnd); }
  function clearExpired(data, day = today()) {
    data.products.forEach(p => { if (expired(p, day)) { p.promoPercent = 0; p.promoStart = ''; p.promoEnd = ''; } });
  }
  function schedule(rate, start, end, day = today()) {
    if (!rate) return {promoStart: '', promoEnd: ''};
    const valid = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value);
    if (!valid(start) || !valid(end)) throw new Error('Enter valid promo dates.');
    if (start && end && start > end) throw new Error('Promo end date must be on or after its start date.');
    if (end && end < day) throw new Error('Promo end date cannot be in the past.');
    return {promoStart: start || '', promoEnd: end || ''};
  }
  return {today, activeRate, expired, clearExpired, schedule};
})();
