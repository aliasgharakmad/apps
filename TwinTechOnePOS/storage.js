/* One versioned document keeps sales, stock, and register changes together. */
(() => {
  'use strict';
  const KEY = 'twintech-onepos-browser-v1';
  const fresh = () => ({ version: 1, settings: { name: 'My Store', address: '', cashier: 'Owner', vat: 12, tin: '' }, products: [], customers: [], sales: [], registers: [], movements: [], refunds: [], cashMovements: [], vouchers: [] });
  let revision = null;
  let ready = false;

  function validate(data) {
    if (!data || data.version !== 1 || !data.settings || typeof data.settings.name !== 'string' || typeof data.settings.cashier !== 'string' || !Number.isFinite(data.settings.vat) || data.settings.vat < 0 || data.settings.vat > 100) throw new Error('Invalid local store data.');
    for (const key of ['products', 'customers', 'sales', 'registers', 'movements']) {
      if (!Array.isArray(data[key])) throw new Error('Invalid local store data.');
    }
    if (data.cashMovements !== undefined && !Array.isArray(data.cashMovements)) throw new Error('Invalid cash movement data.');
    if (data.refunds !== undefined && !Array.isArray(data.refunds)) throw new Error('Invalid refund data.');
    if (data.vouchers !== undefined && !Array.isArray(data.vouchers)) throw new Error('Invalid voucher data.');
    return data;
  }

  function load() {
    try {
      revision = localStorage.getItem(KEY);
      const data = revision === null ? fresh() : validate(JSON.parse(revision));
      if (revision === null) {
        revision = JSON.stringify(data);
        localStorage.setItem(KEY, revision);
      }
      ready = true;
      return data;
    } catch (error) {
      ready = false;
      throw new Error('Browser storage cannot be opened. Existing data has not been replaced. Check browser storage permissions. ' + error.message);
    }
  }

  function update(change) {
    if (!ready) throw new Error('Storage is unavailable. Reload after resolving the storage error.');
    if (localStorage.getItem(KEY) !== revision) {
      throw new Error('Store data changed in another tab. Reload this page before continuing. Use one POS tab at a time.');
    }
    const next = validate(JSON.parse(revision));
    const result = change(next);
    const serialized = JSON.stringify(validate(next));
    try { localStorage.setItem(KEY, serialized); }
    catch { throw new Error('Could not save. Browser storage may be full or blocked. No changes were committed.'); }
    revision = serialized;
    return { data: next, result };
  }

  function inspect(snapshot) {
    return validate(snapshot);
  }

  function replace(snapshot) {
    if (!ready) throw new Error('Storage is unavailable. Reload after resolving the storage error.');
    if (localStorage.getItem(KEY) !== revision) {
      throw new Error('Store data changed in another tab. Reload this page before restoring a backup. Use one POS tab at a time.');
    }
    const restored = validate(snapshot);
    const serialized = JSON.stringify(restored);
    try { localStorage.setItem(KEY, serialized); }
    catch { throw new Error('Could not restore. Browser storage may be full or blocked. Existing data has not been replaced.'); }
    revision = serialized;
    return restored;
  }

  window.OnePOSStorage = { load, update, inspect, replace, key: KEY };
})();
