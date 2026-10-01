/* Local voucher validation, eligibility, and discounts. */
window.OnePOSVouchers = (() => {
  'use strict';
  const today = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
  const normalizeCode = value => String(value || '').trim().toUpperCase();

  function usage(data, voucher) {
    const used = (data.sales || []).filter(sale => sale.voucherId === voucher.id).length;
    const limit = voucher.usageMode === 'single' ? 1 : (voucher.maxUses || Infinity);
    return {used, limit, remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : null};
  }

  function evaluate(data, voucherId, subtotal, day = today()) {
    const voucher = (data.vouchers || []).find(item => item.id === voucherId);
    if (!voucher) return {valid: false, reason: 'Voucher not found.', discount: 0};
    if (voucher.status !== 'active') return {valid: false, reason: 'This voucher is inactive.', discount: 0, voucher};
    if (voucher.startDate && day < voucher.startDate) return {valid: false, reason: `This voucher starts on ${voucher.startDate}.`, discount: 0, voucher};
    if (voucher.endDate && day > voucher.endDate) return {valid: false, reason: 'This voucher has expired.', discount: 0, voucher};
    if (subtotal < (voucher.minimumSubtotal || 0)) return {valid: false, reason: `Order subtotal must be at least ${money(voucher.minimumSubtotal)}.`, discount: 0, voucher};
    const count = usage(data, voucher);
    if (count.used >= count.limit) return {valid: false, reason: 'This voucher has reached its use limit.', discount: 0, voucher, ...count};
    const uncapped = voucher.discountType === 'percent'
      ? Math.round(subtotal * voucher.discountValue / 100)
      : voucher.discountValue;
    const discount = Math.min(subtotal, voucher.maxDiscount ? Math.min(uncapped, voucher.maxDiscount) : uncapped);
    if (discount <= 0) return {valid: false, reason: 'This voucher does not discount this order.', discount: 0, voucher, ...count};
    return {valid: true, reason: '', discount, voucher, ...count};
  }

  function money(centavos) {
    return new Intl.NumberFormat('en-PH', {style: 'currency', currency: 'PHP'}).format(centavos / 100);
  }

  function validateDefinition(fields, data, existingId = '') {
    const name = String(fields.name || '').trim();
    const code = normalizeCode(fields.code);
    const description = String(fields.description || '').trim();
    const discountType = fields.discountType;
    const discountValueNumber = Number(fields.discountValue);
    const usageMode = fields.usageMode;
    if (!name || name.length > 100) throw new Error('Enter a voucher name of 1 to 100 characters.');
    if (!/^[A-Z0-9-]{3,25}$/.test(code)) throw new Error('Voucher code must be 3 to 25 letters, numbers, or hyphens.');
    if ((data.vouchers || []).some(item => item.id !== existingId && normalizeCode(item.code) === code)) throw new Error('That voucher code already exists.');
    if (!['percent', 'fixed'].includes(discountType)) throw new Error('Choose a valid discount type.');
    if (!Number.isFinite(discountValueNumber) || discountValueNumber <= 0 || (discountType === 'percent' && discountValueNumber > 100)) {
      throw new Error(discountType === 'percent' ? 'Percentage discount must be greater than 0 and no more than 100%.' : 'Enter a fixed discount amount greater than zero.');
    }
    if (description.length > 300) throw new Error('Description must be 300 characters or fewer.');
    if (!['single', 'multiple'].includes(usageMode)) throw new Error('Choose whether this voucher is single-use or multiple-use.');
    const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    const startDate = String(fields.startDate || '');
    const endDate = String(fields.endDate || '');
    if (!validDate(startDate) || !validDate(endDate)) throw new Error('Enter valid voucher dates.');
    if (startDate && endDate && startDate > endDate) throw new Error('Voucher end date must be on or after its start date.');
    if (endDate && endDate < today()) throw new Error('Voucher end date cannot be in the past.');
    const maxUses = usageMode === 'multiple' && String(fields.maxUses || '').trim() !== '' ? Number(fields.maxUses) : null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10000000)) throw new Error('Maximum uses must be a whole number from 1 to 10,000,000.');
    if (!['active', 'inactive'].includes(fields.status)) throw new Error('Choose whether the voucher is active or inactive.');
    const value = discountType === 'percent' ? discountValueNumber : toCentavos(discountValueNumber);
    const maximum = discountType === 'percent' && String(fields.maxDiscount || '').trim() !== '' ? toCentavos(fields.maxDiscount) : 0;
    const minimum = String(fields.minimumSubtotal || '').trim() === '' ? 0 : toCentavos(fields.minimumSubtotal);
    return {
      name, code, description, discountType, discountValue: value,
      maxDiscount: maximum, minimumSubtotal: minimum, usageMode,
      maxUses: usageMode === 'single' ? 1 : maxUses,
      startDate, endDate, status: fields.status
    };
  }

  function toCentavos(value) {
    if (String(value).trim() === '') return 0;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100000000) throw new Error('Enter a valid amount between 0 and 100,000,000.');
    return Math.round(number * 100);
  }

  function formatDiscount(voucher) {
    if (!voucher) return '';
    return voucher.discountType === 'percent' ? `${voucher.discountValue}% off` : `${money(voucher.discountValue)} off`;
  }

  return {today, normalizeCode, usage, evaluate, validateDefinition, toCentavos, money, formatDiscount};
})();
