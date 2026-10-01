/* Browser UI. Persistence and atomic writes live in storage.js. */
(() => {
  'use strict';
  const store = window.OnePOSStorage;
  const refunds = window.OnePOSRefunds;
  const promos = window.OnePOSPromos;
  const vouchers = window.OnePOSVouchers;
  let promoDay = promos.today();
  const content = document.querySelector('#content');
  const dialog = document.querySelector('#dialog');
  const money = cents => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(cents / 100);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function nextReceiptNumber(sales) {
    const highest = sales.reduce((max, sale) => {
      const digits = String(sale.number || '').match(/^\d+$/);
      if (!digits) return max;
      const number = BigInt(digits[0]);
      return number > max ? number : max;
    }, 0n);
    return (highest + 1n).toString().padStart(6, '0');
  }
  const now = () => new Date().toISOString();
  const date = value => new Date(value).toLocaleString();
  let data;
  let pendingRestore = null;
  let view = 'pos';
  let cart = [];
  let appliedVoucherId = '';
  let search = '';
  let salesScanTimer = null;
  let voucherScanTimer = null;
  const managementSearch = { products: '', inventory: '' };
  const managementExact = { products: false, inventory: false };
  let customerId = '';
  let inventoryStatus = 'all';
  let noticeTimer = null;
  const pageSize = 10;
  const listPages = { products: 1, inventory: 1, vouchers: 1, history: 1 };

  function notice(message, error = false) {
    const el = document.querySelector('#notice');
    clearTimeout(noticeTimer);
    el.textContent = message;
    el.className = error ? 'error' : '';
    el.hidden = !message;
    if (message && !dialog.open) dismissNoticeLater();
  }
  function dismissNoticeLater() {
    clearTimeout(noticeTimer);
    const el = document.querySelector('#notice');
    if (!el.hidden) noticeTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }
  function save(change) {
    const saved = store.update(next => { promos.clearExpired(next); return change(next); });
    data = saved.data;
    return saved.result;
  }
  function amount(value, label = 'Amount') {
    if (String(value).trim() === '') throw new Error(`${label} is required.`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100000000) throw new Error(`${label} must be between 0 and 100,000,000.`);
    return Math.round(number * 100);
  }
  function integer(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw new Error('Stock must be a whole number between 0 and 10,000,000.');
    return n;
  }
  function required(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} is required.`);
    return text;
  }
  const activeRegister = () => data.registers.find(r => !r.closedAt);
  const total = () => cart.reduce((sum, line) => sum + promoPrice(data.products.find(p => p.id === line.id)) * line.quantity, 0);
  function promoPrice(product) {
    return product.price - Math.round(product.price * discountRate(promos.activeRate(product)) / 100);
  }
  function priceLabel(product) {
    return promos.activeRate(product) > 0 ? `<span class="promo-price">${money(promoPrice(product))}</span> <del class="regular-price">${money(product.price)}</del><small class="promo-label">${product.promoPercent}% promo</small>` : money(product.price);
  }
  function discountRate(value) {
    if (String(value).trim() === '') throw new Error('Enter a discount percentage between 0 and 100.');
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Enter a discount percentage between 0 and 100.');
    return rate;
  }
  function calculateTotals(subtotal, discount, vatRate) {
    const discountedTotal = subtotal - discount;
    const net = Math.round(discountedTotal / (1 + vatRate / 100));
    return { subtotal, discount, total: discountedTotal, net, vat: discountedTotal - net };
  }
  function orderTotals(subtotal = total(), vatRate = data.settings.vat) {
    const voucherResult = appliedVoucherId
      ? vouchers.evaluate(data, appliedVoucherId, subtotal)
      : {valid: true, discount: 0, voucher: null};
    const totals = calculateTotals(subtotal, voucherResult.valid ? voucherResult.discount : 0, vatRate);
    return {...totals, voucherResult};
  }
  function totalsRows(totals) {
    const voucher = totals.voucherResult?.valid ? totals.voucherResult.voucher : null;
    return `<div class="row"><span>Subtotal after product promos</span><span>${money(totals.subtotal)}</span></div>${totals.discount ? `<div class="row"><span>Voucher (${escape(voucher?.code || '')})</span><span>−${money(totals.discount)}</span></div>` : ''}<div class="row"><span>Net sales</span><span>${money(totals.net)}</span></div><div class="row"><span>VAT (${data.settings.vat}%, included)</span><span>${money(totals.vat)}</span></div><div class="row total"><span>Total</span><span>${money(totals.total)}</span></div>`;
  }
  const button = (action, label, id = '', cls = 'secondary', disabled = false) => `<button type="button" class="${cls}" data-action="${action}" data-id="${escape(id)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  function modal(html) {
    window.OnePOSCamera.stop();
    const dialogContent = document.querySelector('#dialog-content');
    const dialogActions = document.querySelector('#dialog-actions');
    const dismissButton = document.querySelector('#dismiss-dialog');
    dismissButton.textContent = 'Close';
    dialogContent.innerHTML = html;
    dialogActions.replaceChildren(dismissButton);

    dialogContent.querySelectorAll('form').forEach((form, index) => {
      if (!form.id) form.id = `dialog-form-${index + 1}`;
      form.querySelectorAll('button[type="submit"], button:not([type])').forEach(button => {
        button.setAttribute('form', form.id);
        dialogActions.append(button);
      });
    });
    dialogContent.querySelectorAll('[data-action="print"]').forEach(button => dialogActions.append(button));
    if (!dialog.open) dialog.showModal();
  }
  function table(headers, rows) {
    return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">No records yet.</td></tr>`}</tbody></table></div>`;
  }
  function pagedItems(items, list) {
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    const current = listPages[list] = Math.min(Math.max(1, listPages[list]), pages);
    const start = (current - 1) * pageSize;
    const footer = `<div class="pagination"><small>Showing ${items.length ? start + 1 : 0}–${Math.min(start + pageSize, items.length)} of ${items.length}</small>${pages > 1 ? `<div class="pagination-controls"><button type="button" class="secondary" data-action="page" data-list="${list}" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''}>Previous</button><span>Page ${current} of ${pages}</span><button type="button" class="secondary" data-action="page" data-list="${list}" data-page="${current + 1}" ${current === pages ? 'disabled' : ''}>Next</button></div>` : ''}</div>`;
    return { items: items.slice(start, start + pageSize), footer };
  }
  function focusSearch() {
    if (dialog.open) return;
    const selector = view === 'pos' ? '#search' : ['products', 'inventory'].includes(view) ? '#inventory-search' : null;
    if (selector) document.querySelector(selector)?.focus({ preventScroll: true });
  }
  function render() {
    clearTimeout(salesScanTimer);
    clearTimeout(voucherScanTimer);
    document.querySelector('#store-label').textContent = data.settings.name;
    const storeAddress = document.querySelector('#store-address');
    storeAddress.textContent = data.settings.address || '';
    storeAddress.hidden = !data.settings.address;
    document.querySelector('#cashier-label').textContent = `Operator: ${data.settings.cashier}`;
    const registerStatus = document.querySelector('#register-status');
    const isRegisterOpen = Boolean(activeRegister());
    registerStatus.textContent = isRegisterOpen ? 'Register Open' : 'Register Closed';
    registerStatus.classList.toggle('register-closed', !isRegisterOpen);
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    ({ pos: renderPOS, products: renderProducts, inventory: renderInventory, customers: renderCustomers, vouchers: renderVouchers, history: renderHistory, reports: renderReports, register: renderRegister, settings: renderSettings })[view]();
    focusSearch();
  }
  function renderPOS() {
    content.innerHTML = `<div class="layout"><section><h1>New sale</h1>${activeRegister() ? '' : '<p class="muted">Open your register before completing a sale.</p>'}<input id="search" class="search" placeholder="Search name, category, or scan barcode" aria-label="Search products by name, category, or barcode" value="${escape(search)}"><div id="top-sellers"></div><div id="catalog" class="grid"></div></section><aside class="card"><div class="row"><h2>Current order</h2>${button('clear-cart', 'Clear')}</div><div id="cart"></div></aside></div>`;
    renderCatalog();
    renderCart();
  }
  function renderCatalog() {
    const term = search.trim().toLowerCase();
    const exactBarcode = Boolean(term) && data.products.some(p => String(p.barcode || '').trim().toLowerCase() === term);
    const products = data.products.filter(p => exactBarcode
      ? String(p.barcode || '').trim().toLowerCase() === term
      : [p.name, p.category, p.barcode].some(value => String(value || '').toLowerCase().includes(term)));
    const registerOpen = Boolean(activeRegister());
    renderTopSellers();
    document.querySelector('#catalog').innerHTML = products.map(p => `<button class="product" data-action="add" data-id="${escape(p.id)}" ${p.stock === 0 || !registerOpen ? 'disabled' : ''}>${productImage(p)}<small>${escape(p.category)} · ${p.stock} in stock</small><strong>${escape(p.name)}</strong><span>${priceLabel(p)}</span></button>`).join('') || '<p class="empty">No products found. Add products on the Products page.</p>';
  }
  function renderTopSellers() {
    const container = document.querySelector('#top-sellers');
    if (!container) return;
    const quantities = new Map();
    data.sales.forEach(sale => sale.items.forEach((item, index) => {
      const remaining = refunds.remaining(data, sale, index);
      if (remaining > 0) quantities.set(item.productId, (quantities.get(item.productId) || 0) + remaining);
    }));
    const products = [...quantities].map(([id, sold]) => ({product: data.products.find(item => item.id === id), sold}))
      .filter(entry => entry.product)
      .sort((a, b) => b.sold - a.sold || a.product.name.localeCompare(b.product.name))
      .slice(0, 5);
    container.innerHTML = products.length ? `<div class="quick-sellers"><small class="quick-sellers-label">Top sellers</small><div class="quick-seller-list">${products.map(({product, sold}) => {
      const ordered = cart.find(line => line.id === product.id)?.quantity || 0;
      const disabled = !activeRegister() || product.stock <= ordered;
      return `<button type="button" class="quick-seller" data-action="add" data-id="${escape(product.id)}" ${disabled ? 'disabled' : ''}><strong>${escape(product.name)}</strong><span>${money(promoPrice(product))}</span><small>${sold} sold</small></button>`;
    }).join('')}</div></div>` : '';
  }
  function renderCart() {
    const gross = total();
    const totals = orderTotals(gross);
    const registerOpen = Boolean(activeRegister());
    const checkoutHint = !registerOpen
      ? `<p class="checkout-hint" role="status">Open a register before checkout. ${button('go-register', 'Open register')}</p>`
      : !totals.voucherResult.valid ? `<p class="checkout-hint error" role="status">${escape(totals.voucherResult.reason)} Remove the voucher or adjust the order.</p>` : '';
    const voucherResult = totals.voucherResult;
    const voucherPanel = `<div class="voucher-entry"><label>Voucher code / scan QR<input id="voucher-code-input" maxlength="25" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Enter or scan voucher code"></label></div>${appliedVoucherId ? `<div class="applied-voucher ${voucherResult.valid ? '' : 'voucher-invalid'}"><span>${voucherResult.valid ? `Applied: ${escape(voucherResult.voucher.name)} (${escape(voucherResult.voucher.code)}) · ${money(voucherResult.discount)} off` : escape(voucherResult.reason)}</span>${button('remove-voucher', 'Remove')}</div>` : '<small class="voucher-help">Scan with a QR scanner while this field is focused, or type the code.</small>'}`;
    document.querySelector('#cart').innerHTML = cart.map(line => {
      const p = data.products.find(p => p.id === line.id);
      return `<div class="cart-line"><div class="row"><strong>${escape(p.name)}</strong><span>${money(promoPrice(p) * line.quantity)}</span></div>${promos.activeRate(p) > 0 ? `<small class="promo-label">${p.promoPercent}% promo · ${money(promoPrice(p))} each</small>` : ''}<div class="quantity">${button('minus', '−', p.id)}<span>${line.quantity}</span>${button('add', '+', p.id, 'secondary', !registerOpen)}</div></div>`;
    }).join('') + `${cart.length ? '' : '<p class="empty">Add products to begin.</p>'}${checkoutHint}${voucherPanel}<div class="customer-picker"><small>Customer</small><details id="sale-customer-picker"><summary>${escape(data.customers.find(c => c.id === customerId)?.name || 'Walk-in customer')}</summary><div class="customer-options">${button('choose-sale-customer', 'Walk-in customer')}${data.customers.map(c => button('choose-sale-customer', escape(c.name), c.id)).join('')}</div></details></div><div id="order-totals">${totalsRows(totals)}</div><button class="wide" data-action="checkout" ${!cart.length || !registerOpen || !voucherResult.valid ? 'disabled' : ''}>Cash checkout</button>`;
  }
  function add(id) {
    if (!activeRegister()) throw new Error('Open a register before adding products to the order.');
    const product = data.products.find(p => p.id === id);
    if (!product) throw new Error('Product no longer exists.');
    const line = cart.find(x => x.id === id);
    if ((line?.quantity || 0) >= product.stock) throw new Error('Not enough stock.');
    if (line) line.quantity++;
    else cart.push({ id, quantity: 1 });
    renderCart();
    renderTopSellers();
  }
  function managementSearchPanel() {
    return `<div class="card"><label for="inventory-search">Search products or scan barcode</label><div class="row"><input id="inventory-search" type="search" placeholder="Name, category, or barcode" value="${escape(managementSearch[view])}" autocomplete="off" spellcheck="false" aria-describedby="inventory-search-help">${button('clear-inventory-search', 'Clear')}</div><small id="inventory-search-help">Click the search field and scan. Barcode matches appear automatically; no Enter required.</small><p id="inventory-results-count" role="status"></p><div id="inventory-results"></div></div>`;
  }
  function renderProducts() {
    content.innerHTML = `<div class="toolbar"><h1>Products</h1>${button('product', 'Add product', '', '')}</div><p class="muted">Manage product details, images, categories, prices, and costs.</p>${managementSearchPanel()}`;
    renderInventoryResults();
  }
  function renderInventory() {
    const units = data.products.reduce((sum, p) => sum + p.stock, 0);
    const low = data.products.filter(p => p.stock > 0 && p.stock <= 10).length;
    const empty = data.products.filter(p => p.stock === 0).length;
    content.innerHTML = `<h1>Inventory</h1><p class="muted">Adjust stock and review recorded movements. Low stock means 10 or fewer units.</p><div class="metrics">${[['All products', data.products.length, 'all'], ['Units on hand', units, null], ['Low stock', low, 'low'], ['Out of stock', empty, 'out']].map(([label, value, filter]) => filter ? `<button type="button" class="card stock-filter stock-filter-${filter}" data-action="filter-stock" data-id="${filter}" aria-pressed="${inventoryStatus === filter}"><small>${label}</small><strong>${value}</strong></button>` : '<div class="card"><small>' + label + '</small><strong>' + value + '</strong></div>').join('')}</div>${managementSearchPanel()}`;
    renderInventoryResults();
  }
  function renderInventoryResults() {
    const term = managementSearch[view].trim().toLowerCase();
    const exactBarcode = Boolean(term) && data.products.some(p => String(p.barcode || '').trim().toLowerCase() === term);
    const exactMatch = managementExact[view] || exactBarcode;
    const products = data.products.filter(p => view !== 'inventory' || inventoryStatus === 'all' || (inventoryStatus === 'low' ? p.stock > 0 && p.stock <= 10 : p.stock === 0)).filter(p => exactMatch
      ? String(p.barcode || '').trim().toLowerCase() === term
      : [p.name, p.category, p.barcode].some(value => String(value || '').toLowerCase().includes(term)));
    document.querySelector('#inventory-results-count').textContent = products.length + ' of ' + data.products.length + ' products' + (view === 'inventory' && inventoryStatus !== 'all' ? inventoryStatus === 'low' ? ' · Low stock' : ' · Out of stock' : '') + (exactMatch ? ' · Exact barcode match' : '');
    const page = pagedItems(products, view);
    const stockView = view === 'inventory';
    const headers = stockView ? ['Product', 'Barcode', 'On hand', 'Status', 'Actions'] : ['Product', 'Barcode', 'Price', 'Cost', 'Actions'];
    const rows = page.items.map(p => {
      const identity = `<td>${productImage(p, 'product-thumbnail')}<strong>${escape(p.name)}</strong><small>${escape(p.category)}</small></td><td>${escape(p.barcode)}</td>`;
      return '<tr>' + identity + (stockView
        ? `<td>${p.stock}</td><td><span class="stock-status ${p.stock === 0 ? 'stock-out' : p.stock <= 10 ? 'stock-low' : 'stock-in'}">${p.stock === 0 ? 'Out of stock' : p.stock <= 10 ? 'Low stock' : 'In stock'}</span></td><td>${button('stock', 'Adjust stock', p.id)} ${button('stock-history', 'History', p.id)}</td>`
        : `<td>${priceLabel(p)}</td><td>${money(p.cost)}</td><td>${button('product', 'Edit', p.id)} ${button('delete-product', 'Delete', p.id)}</td>`) + '</tr>';
    }).join('');
    document.querySelector('#inventory-results').innerHTML = (products.length ? table(headers, rows) : '<p class="empty">No matching products. Try another search or clear the field.</p>') + page.footer;
  }
  function stockHistory(id) {
    const product = data.products.find(p => p.id === id);
    if (!product) throw new Error('Product no longer exists.');
    const movements = data.movements.filter(m => m.productId === id).slice().reverse();
    modal(`<h2>${escape(product.name)} — Stock history</h2><p>Current stock: <strong>${product.stock}</strong></p><p class="muted">Recorded changes only. Older opening quantities may not have a history entry.</p>${table(['Date', 'Change', 'Reason'], movements.map(m => '<tr><td>' + date(m.createdAt) + '</td><td>' + (m.change > 0 ? '+' : '') + m.change + '</td><td>' + escape(m.reason) + '</td></tr>').join(''))}`);
  }
  function categories() {
    return [...new Set([...(data.categories || []), ...data.products.map(p => p.category)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  function productImage(product, className = 'product-image') {
    const preset = window.OnePOSImageCatalog.find(item => item.id === product.imageId);
    const src = preset?.src || (/^data:image\/(jpeg|png|webp);base64,/.test(product.image || '') ? product.image : '');
    return src ? `<img class="${className}" src="${escape(src)}" alt="${escape(product.name)}" loading="lazy">` : '';
  }
  function productImagePreview(product) {
    const image = productImage(product);
    return image ? `<div class="image-preview-frame">${image}<button type="button" class="image-remove-button" data-action="remove-image" aria-label="Remove product image" title="Remove image">×</button></div>` : '';
  }
  function imagePicker(selectedId) {
    const groups = [...new Set(window.OnePOSImageCatalog.map(item => item.category))];
    return '<details class="image-library"><summary>Choose Image</summary>' + groups.map(group => '<h3>' + escape(group) + '</h3><div class="image-options">' + window.OnePOSImageCatalog.filter(item => item.category === group).map(item => `<button type="button" class="image-option" data-action="select-image" data-id="${item.id}" aria-pressed="${item.id === selectedId}"><img src="${item.src}" alt=""><span>${escape(item.name)}</span></button>`).join('') + '</div>').join('') + '</details>';
  }
  function markImageSelection(form) {
    form.querySelectorAll('[data-action="select-image"]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.id === form.productImageId)));
  }
  function productForm(id) {
    const p = data.products.find(p => p.id === id) || { name: '', category: '', barcode: '', price: 0, cost: 0, stock: 0 };
    const choices = categories();
    const selected = p.category || choices[0] || '__new__';
    modal(`<h2>${id ? 'Edit' : 'Add'} product</h2><form data-form="product" data-id="${escape(id)}"><label>Name<input name="name" maxlength="100" required value="${escape(p.name)}"></label><div class="form-grid"><label>Category<select name="category" id="product-category">${choices.map(c => `<option value="${escape(c)}" ${c === selected ? 'selected' : ''}>${escape(c)}</option>`).join('')}<option value="__new__" ${selected === '__new__' ? 'selected' : ''}>+ Add new category</option></select></label><label id="new-category-label" ${selected !== '__new__' ? 'hidden' : ''}>New category<input name="newCategory" maxlength="60" ${selected === '__new__' ? 'required' : 'disabled'}></label><label>Barcode<input name="barcode" maxlength="80" value="${escape(p.barcode)}"></label><label>Price (VAT inclusive)<input name="price" type="number" min="0" step="0.01" required value="${p.price / 100}"></label><label>Unit cost<input name="cost" type="number" min="0" step="0.01" required value="${p.cost / 100}"></label>${id ? '' : '<label>Opening stock<input name="stock" type="number" min="0" step="1" value="0" required></label>'}</div><fieldset class="product-promo"><legend>Product promo (optional)</legend><div class="form-grid"><label>Promo discount (%) — optional<input name="promoPercent" type="number" min="0" max="100" step="0.01" placeholder="No promo" value="${p.promoPercent || ''}"><small>Applied before any voucher. Clear to remove.</small></label><label>Promo start — optional<input name="promoStart" type="date" value="${escape(p.promoStart || '')}"><small>Blank means start now.</small></label><label>Promo end — optional<input name="promoEnd" type="date" value="${escape(p.promoEnd || '')}"><small>Active through this date (Philippine time). Blank means no expiry.</small></label></div></fieldset>${imagePicker(p.imageId)}<div class="photo-controls"><span class="image-choice-or">or</span> <button type="button" class="secondary" data-action="take-picture">Take picture</button><small>Use your camera to photograph the product. Pictures are resized and saved only when you save the product.</small></div><div class="camera-panel" hidden><video autoplay muted playsinline aria-label="Product camera preview"></video><div class="row"><button type="button" data-action="capture-photo">Capture photo</button><button type="button" class="secondary" data-action="cancel-camera">Cancel camera</button></div></div><div id="product-image-preview">${productImagePreview(p)}</div><p id="image-status" role="status"></p><button type="submit">Save product</button></form>`);
    const form = document.querySelector('form[data-form="product"]');
    form.productImage = p.image || '';
    form.productImageId = p.imageId || '';
  }
  function renderCustomers() {
    content.innerHTML = `<div class="toolbar"><h1>Customers</h1>${button('customer', 'Add customer', '', '')}</div><div class="card">${table(['Name', 'Phone', 'Email', 'Actions'], data.customers.map(c => `<tr><td>${escape(c.name)}</td><td>${escape(c.phone)}</td><td>${escape(c.email)}</td><td>${button('customer', 'Edit', c.id)} ${button('delete-customer', 'Delete', c.id)}</td></tr>`).join(''))}</div>`;
  }
  function customerForm(id) {
    const c = data.customers.find(c => c.id === id) || {};
    modal(`<h2>${id ? 'Edit' : 'Add'} customer</h2><form data-form="customer" data-id="${escape(id)}"><label>Name<input name="name" maxlength="100" required value="${escape(c.name)}"></label><label>Phone<input name="phone" maxlength="40" value="${escape(c.phone)}"></label><label>Email<input name="email" type="email" maxlength="150" value="${escape(c.email)}"></label><button>Save customer</button></form>`);
  }
  function renderHistory() {
    const page = pagedItems([...data.sales].reverse(), 'history');
    content.innerHTML = '<h1>Sales history</h1><div class="card">' + table(['Date', 'Receipt', 'Customer', 'Original total', 'Status', 'Actions'], page.items.map(s => {
      const status = refunds.status(data, s);
      const canRefund = ['Completed', 'Partially refunded'].includes(status);
      return `<tr><td>${date(s.createdAt)}</td><td>${escape(s.number)}</td><td>${escape(s.customer)}</td><td>${money(s.total)}</td><td>${escape(status)}</td><td>${button('receipt', 'View receipt', s.id)} ${canRefund ? button('refund-sale', 'Refund', s.id) : ''} ${status === 'Completed' ? button('void-sale', 'Void sale', s.id) : ''}</td></tr>`;
    }).join('')) + page.footer + '</div>';
  }
  function refundForm(id, type = 'REFUND') {
    if (!activeRegister()) throw new Error('Open a register before paying a cash refund.');
    const sale = data.sales.find(s => s.id === id);
    if (!sale) throw new Error('Sale not found.');
    const isVoid = type === 'VOID';
    modal(`<h2>${isVoid ? 'Void' : 'Refund'} sale ${escape(sale.number)}</h2><p>${isVoid ? 'Reverse the entire sale and return its cash payment.' : 'Choose quantities to refund.'} Original discounted amounts apply. Only check Return to stock for reusable items.</p><form data-form="refund" data-id="${sale.id}" data-type="${type}" data-refund-id="${uid()}">${table(['Item', 'Remaining', 'Refund qty', 'Return to stock'], sale.items.map((item, index) => {
      const left = refunds.remaining(data, sale, index);
      const exists = data.products.some(p => p.id === item.productId);
      return `<tr><td>${escape(item.name)}</td><td>${left}</td><td><input aria-label="Refund quantity for ${escape(item.name)}" name="qty-${index}" type="number" min="0" max="${left}" step="1" value="${isVoid ? left : 0}" ${isVoid || !left ? 'readonly' : ''} required></td><td><input aria-label="Return ${escape(item.name)} to stock" name="restock-${index}" type="checkbox" ${!exists || !left ? 'disabled' : ''}></td></tr>`;
    }).join(''))}<label>Reason<input name="reason" maxlength="300" required></label><p id="refund-preview" role="status"></p><button type="submit" class="danger">${isVoid ? 'Confirm void' : 'Confirm refund'}</button></form>`);
    updateRefundPreview(document.querySelector('form[data-form="refund"]'));
  }
  function refundFields(form) {
    const fields = Object.fromEntries(new FormData(form));
    const sale = data.sales.find(s => s.id === form.dataset.id);
    return { quantities: sale.items.map((_, i) => fields['qty-' + i]), restock: sale.items.map((_, i) => fields['restock-' + i] === 'on'), reason: fields.reason };
  }
  function updateRefundPreview(form) {
    const box = form.querySelector('#refund-preview');
    try {
      const fields = refundFields(form);
      const quote = refunds.quote(data, data.sales.find(s => s.id === form.dataset.id), fields.quantities, fields.restock, form.dataset.type);
      box.textContent = 'Cash to return: ' + money(quote.total);
    } catch (error) { box.textContent = error.message; }
  }
  function refundReceipt(id) {
    const r = (data.refunds || []).find(r => r.id === id);
    if (!r) throw new Error('Refund not found.');
    const address = r.address || data.settings.address || '';
    modal(`<div class="receipt"><h2>${escape(r.store)}</h2>${address ? `<p class="receipt-address">${escape(address)}</p>` : ''}${r.tin ? `<p class="receipt-tin">TIN: ${escape(r.tin)}</p>` : ''}<h3>${r.type === 'VOID' ? 'Void' : 'Refund'} receipt ${escape(r.number)}</h3><p>Original sale ${escape(r.saleNumber)}<small>${date(r.createdAt)} · ${escape(r.cashier)}</small></p>${table(['Item', 'Qty', 'Stock returned', 'Refund'], r.items.map(i => '<tr><td>' + escape(i.name) + '</td><td>' + i.quantity + '</td><td>' + (i.restock ? 'Yes' : 'No') + '</td><td>' + money(i.total) + '</td></tr>').join(''))}<p>Reason: ${escape(r.reason)}</p><div class="row"><span>Net reversal</span><span>${money(r.net)}</span></div><div class="row"><span>VAT reversal</span><span>${money(r.vat)}</span></div><div class="row total"><span>Cash returned</span><span>${money(r.total)}</span></div></div>${button('print', 'Print receipt', '', '')}`);
  }
  function refundSummary(sale) {
    const records = refunds.forSale(data, sale.id);
    return records.length ? '<h3>' + escape(refunds.status(data, sale)) + '</h3><p>Cash returned: ' + money(records.reduce((sum, r) => sum + r.total, 0)) + '</p>' + records.map(r => button('refund-receipt', escape(r.number) + ' · ' + money(r.total), r.id)).join(' ') : '';
  }
  function receipt(id) {
    const s = data.sales.find(s => s.id === id);
    if (!s) throw new Error('Sale not found.');
    const subtotal = s.subtotal ?? s.total;
    const discount = s.discount ?? 0;
    const rate = s.discountPercent ?? 0;
    const discountRow = s.voucherCode
      ? `<div class="row"><span>Discount</span><span>−${money(discount)}</span></div>`
      : discount ? `<div class="row"><span>Discount (${rate}%)</span><span>−${money(discount)}</span></div>` : '';
    const address = s.address ?? data.settings.address ?? '';
    modal(`<div class="receipt"><h2>${escape(s.store)}</h2>${address ? `<p class="receipt-address">${escape(address)}</p>` : ''}${s.tin ? `<p class="receipt-tin">TIN: ${escape(s.tin)}</p>` : ''}<p>Sale receipt · ${escape(s.number)}<small>${date(s.createdAt)}</small><small>Cashier: ${escape(s.cashier)} · ${escape(s.customer)}</small></p>${table(['Item', 'Qty', 'Amount'], s.items.map(i => `<tr><td>${escape(i.name)}${i.promoPercent > 0 ? `<small>${i.promoPercent}% promo · regular ${money(i.regularPrice)} each</small>` : ''}</td><td>${i.quantity}</td><td>${money(i.price * i.quantity)}</td></tr>`).join(''))}${s.promoDiscount ? `<div class="row"><span>Product promo savings</span><span>${money(s.promoDiscount)}</span></div>` : ''}<div class="row"><span>Subtotal after product promos</span><span>${money(subtotal)}</span></div>${discountRow}<div class="row"><span>Net sales</span><span>${money(s.net)}</span></div><div class="row"><span>VAT (${s.vatRate}%)</span><span>${money(s.vat)}</span></div><div class="row total"><span>Total</span><span>${money(s.total)}</span></div><div class="row"><span>Cash received</span><span>${money(s.received)}</span></div><div class="row"><span>Change</span><span>${money(s.received - s.total)}</span></div><p>Thank you!</p>${refundSummary(s)}</div>${button('print', 'Print receipt', '', '')}`);
  }
  function renderReports() {
    const returns = data.refunds || [];
    const returned = returns.reduce((sum, r) => sum + r.total, 0);
    const reversedNet = returns.reduce((sum, r) => sum + r.net, 0);
    const recoveredCost = returns.reduce((sum, r) => sum + r.items.filter(i => i.restock).reduce((n, i) => n + i.cost * i.quantity, 0), 0);
    const gross = data.sales.reduce((n, s) => n + s.total, 0) - returned;
    const discounts = data.sales.reduce((n, s) => n + ((s.discount || 0) + (s.promoDiscount || 0)), 0);
    const net = data.sales.reduce((n, s) => n + s.net, 0) - reversedNet;
    const costs = data.sales.reduce((n, s) => n + s.items.reduce((v, i) => v + i.cost * i.quantity, 0), 0) - recoveredCost;
    content.innerHTML = `<h1>Reports</h1><p class="muted">All recorded sales in this browser. Totals include refunds and voids. Product costs are reversed only for items returned to stock. Discounts show original sale discounts.</p><div class="metrics">${[['Sales', data.sales.length], ['Sales after refunds', money(gross)], ['Refunds / voids', money(returned)], ['Discounts', money(discounts)], ['VAT', money(gross - net)], ['Product costs', money(costs)], ['Gross profit', money(net - costs)]].map(([label, value]) => `<div class="card"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div><div class="card"><h2>Low stock (10 or fewer)</h2>${table(['Product', 'Stock'], data.products.filter(p => p.stock <= 10).map(p => `<tr><td>${escape(p.name)}</td><td>${p.stock}</td></tr>`).join(''))}</div>`;
  }
  function expected(register) { return window.OnePOSRegister.totals(data, register).expected; }
  function registerBreakdown(register) {
    const t = register.cashSummary || window.OnePOSRegister.totals(data, register);
    return '<div class="metrics">' + [['Opening cash', t.opening], ['Cash sales', t.sales], ['Refunds / voids', -t.refunds], ['Cash in', t.cashIn], ['Cash out', -t.cashOut], ['Expected cash', t.expected]].map(([label, value]) => '<div class="card"><small>' + label + '</small><strong>' + money(value) + '</strong></div>').join('') + '</div>';
  }
  function cashHistory(register) {
    return table(['Date', 'Type', 'Amount', 'Operator', 'Reason'], (data.cashMovements || []).filter(m => m.registerId === register.id).slice().reverse().map(m => '<tr><td>' + date(m.createdAt) + '</td><td>' + (m.type === 'IN' ? 'Cash in' : 'Cash out') + '</td><td>' + money(m.amount) + '</td><td>' + escape(m.cashier) + '</td><td>' + escape(m.reason) + '</td></tr>').join(''));
  }
  function cashMovementForm(type) {
    const register = activeRegister();
    if (!register) throw new Error('Open a register first.');
    modal(`<h2>Cash ${type === 'IN' ? 'in' : 'out'}</h2><p>Expected cash: ${money(expected(register))}</p><form data-form="cash-movement" data-id="${register.id}" data-type="${type}" data-movement-id="${uid()}"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required autofocus></label><label>Reason<input name="reason" maxlength="300" required placeholder="e.g. Additional float or bank deposit"></label><button>Record cash ${type === 'IN' ? 'in' : 'out'}</button></form>`);
  }
  function registerHistory(id) {
    const r = data.registers.find(r => r.id === id);
    if (!r) throw new Error('Register not found.');
    modal(`<h2>Register session</h2><p>Opened ${date(r.openedAt)} by ${escape(r.cashier)}</p>${registerBreakdown(r)}${r.closedAt ? '<p>Counted: ' + money(r.closing) + ' · Variance: ' + money(r.closing - r.expected) + '</p>' : ''}<h3>Cash movements</h3>${cashHistory(r)}`);
  }
  function renderRegister() {
    const r = activeRegister();
    content.innerHTML = `<h1>Register</h1><div class="card">${r ? `<h2>Register open</h2><p>Opened ${date(r.openedAt)} by ${escape(r.cashier)}</p>${registerBreakdown(r)}<div class="row register-actions">${button('cash-in', 'Cash in', '', '')}${button('cash-out', 'Cash out', '', '')}</div><h3>Cash movements</h3>${cashHistory(r)}<form data-form="close-register"><label>Counted closing cash<input name="cash" type="number" min="0" step="0.01" required></label><button>Close register</button></form>` : '<h2>Open a register</h2><form data-form="open-register"><label>Opening cash<input name="cash" type="number" min="0" step="0.01" value="0" required></label><button>Open register</button></form>'}</div><br><div class="card"><h2>Previous sessions</h2>${table(['Closed', 'Cashier', 'Expected', 'Counted', 'Variance', ''], [...data.registers].reverse().filter(r => r.closedAt).map(r => `<tr><td>${date(r.closedAt)}</td><td>${escape(r.cashier)}</td><td>${money(r.expected)}</td><td>${money(r.closing)}</td><td>${money(r.closing - r.expected)}</td><td>${button('register-history', 'Details', r.id)}</td></tr>`).join(''))}</div>`;
  }
  function renderSettings() {
    content.innerHTML = `<h1>Settings</h1><div class="layout"><form class="card" data-form="settings"><label>Store name<input name="name" maxlength="100" required value="${escape(data.settings.name)}"></label><label>Store address (optional)<input name="address" maxlength="200" value="${escape(data.settings.address || '')}" placeholder="Enter store address"></label><label>Operator name<input name="cashier" maxlength="80" required value="${escape(data.settings.cashier)}"></label><label>TIN (optional)<input name="tin" maxlength="30" autocomplete="off" value="${escape(data.settings.tin || '')}" placeholder="Enter business TIN"></label><label>VAT rate (%) included in prices<input name="vat" type="number" min="0" max="100" step="0.01" required value="${data.settings.vat}"></label><button>Save settings</button></form><div class="card"><h2>Browser storage</h2><p>Records are stored only in this browser profile. Use one tab at a time. Clearing browser data removes these records.</p><p>This local version uses an operator name without account authentication. Cash payments and browser receipt printing are supported.</p><div class="row">${button('export', 'Export data')}${button('restore', 'Restore backup')}</div><p class="muted">Restore replaces this browser’s POS records with the selected backup.</p></div></div>`;
  }

  function newVoucherCode() {
    const suffix = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 8) || Math.random().toString(36).slice(2, 10).toUpperCase();
    return `VCH-${suffix.toUpperCase()}`;
  }
  function applyVoucherCode(value) {
    const code = vouchers.normalizeCode(value);
    const voucher = (data.vouchers || []).find(item => vouchers.normalizeCode(item.code) === code);
    if (!voucher) throw new Error('Voucher code not found.');
    const result = vouchers.evaluate(data, voucher.id, total());
    if (!result.valid) throw new Error(result.reason);
    appliedVoucherId = voucher.id;
    renderCart();
    notice(`Voucher applied · ${money(result.discount)} off.`);
    focusSearch();
  }
  function voucherQr(code, className = 'voucher-qr') {
    return `<span class="${className}">${window.OnePOSQR.svg(code)}</span>`;
  }
  function voucherUsageLabel(voucher) {
    const count = vouchers.usage(data, voucher);
    return Number.isFinite(count.limit) ? `${count.used} / ${count.limit} used` : `${count.used} used · multiple use`;
  }
  function renderVouchers() {
    const page = pagedItems([...(data.vouchers || [])].reverse(), 'vouchers');
    const rows = page.items.map(voucher => `<tr><td><strong>${escape(voucher.name)}</strong><small>${escape(voucher.code)}</small><small>${escape(voucher.description || '')}</small></td><td>${escape(vouchers.formatDiscount(voucher))}${voucher.maxDiscount ? `<small>Max ${money(voucher.maxDiscount)}</small>` : ''}<small>Minimum ${money(voucher.minimumSubtotal || 0)}</small></td><td>${escape(voucherUsageLabel(voucher))}</td><td>${escape(voucher.startDate || 'Now')} – ${escape(voucher.endDate || 'No expiry')}</td><td><span class="voucher-status ${voucher.status === 'active' ? 'voucher-active' : 'voucher-inactive'}">${voucher.status === 'active' ? 'Active' : 'Inactive'}</span></td><td>${button('show-voucher', 'Show QR', voucher.id)} ${button('edit-voucher', 'Edit', voucher.id)} ${button('toggle-voucher', voucher.status === 'active' ? 'Deactivate' : 'Activate', voucher.id)}</td></tr>`).join('');
    content.innerHTML = `<div class="toolbar"><h1>Promo vouchers</h1>${button('new-voucher', 'Create voucher', '', '')}</div><p class="muted">Create fixed-amount or percentage vouchers. A voucher can be single-use or reusable, with optional limits, minimum spend, and dates. Cashiers can type its code or scan the QR code at checkout.</p><div class="card">${table(['Voucher', 'Offer', 'Usage', 'Validity', 'Status', 'Actions'], rows)}${page.footer}</div>`;
  }
  function voucherForm(id = '') {
    const voucher = (data.vouchers || []).find(item => item.id === id) || {
      name: '', code: newVoucherCode(), description: '', discountType: 'percent', discountValue: 10,
      maxDiscount: 0, minimumSubtotal: 0, usageMode: 'single', maxUses: null,
      startDate: '', endDate: '', status: 'active'
    };
    const discountValue = voucher.discountType === 'fixed' ? voucher.discountValue / 100 : voucher.discountValue;
    const formAmount = cents => cents ? (cents / 100).toFixed(2) : '';
    modal(`<h2>${id ? 'Edit' : 'Create'} promo voucher</h2><form class="voucher-form" data-form="voucher" data-id="${escape(id)}"><label>Voucher name<input name="name" maxlength="100" required value="${escape(voucher.name)}" placeholder="e.g. Welcome discount"></label><label>Voucher code<input id="voucher-code" name="code" maxlength="25" minlength="3" pattern="[A-Za-z0-9-]{3,25}" required value="${escape(voucher.code)}" autocomplete="off"><small>Letters, numbers, and hyphens only. A QR code is generated for this code.</small></label><label>Description (optional)<textarea name="description" maxlength="300" rows="2">${escape(voucher.description || '')}</textarea></label><div class="form-grid"><label>Discount type<select name="discountType"><option value="percent" ${voucher.discountType === 'percent' ? 'selected' : ''}>Percentage</option><option value="fixed" ${voucher.discountType === 'fixed' ? 'selected' : ''}>Fixed amount (PHP)</option></select></label><label>Discount value<input name="discountValue" type="number" min="0.01" ${voucher.discountType === 'percent' ? 'max="100" step="0.01"' : 'step="0.01"'} required value="${discountValue}"><small data-discount-help>${voucher.discountType === 'percent' ? 'Percent of the order subtotal after product promotions.' : 'PHP off the order subtotal after product promotions.'}</small></label><label data-max-discount ${voucher.discountType !== 'percent' ? 'hidden' : ''}>Maximum discount (optional)<input name="maxDiscount" type="number" min="0.01" step="0.01" value="${formAmount(voucher.maxDiscount)}"><small>Cap the savings on percentage vouchers.</small></label><label>Minimum order subtotal (PHP)<input name="minimumSubtotal" type="number" min="0" step="0.01" value="${formAmount(voucher.minimumSubtotal)}"><small>Based on prices after product promos.</small></label><label>Usage<select name="usageMode"><option value="single" ${voucher.usageMode === 'single' ? 'selected' : ''}>One-time use (one redemption total)</option><option value="multiple" ${voucher.usageMode === 'multiple' ? 'selected' : ''}>Multiple use</option></select></label><label data-max-uses ${voucher.usageMode !== 'multiple' ? 'hidden' : ''}>Maximum total uses (optional)<input name="maxUses" type="number" min="1" step="1" value="${voucher.maxUses || ''}"><small>Leave blank for unlimited redemptions.</small></label><label>Start date (optional)<input name="startDate" type="date" value="${escape(voucher.startDate || '')}"><small>Blank means available now.</small></label><label>End date (optional)<input name="endDate" type="date" value="${escape(voucher.endDate || '')}"><small>Available through this date, Philippines time.</small></label><label>Status<select name="status"><option value="active" ${voucher.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${voucher.status === 'inactive' ? 'selected' : ''}>Inactive</option></select></label></div><button type="submit">Save voucher</button></form>`);
  }
  function showVoucher(id) {
    const voucher = (data.vouchers || []).find(item => item.id === id);
    if (!voucher) throw new Error('Voucher not found.');
    const count = vouchers.usage(data, voucher);
    modal(`<div class="voucher-print-card"><h2>${escape(data.settings.name)}</h2><h3>${escape(voucher.name)}</h3>${voucherQr(voucher.code)}<p class="voucher-code">${escape(voucher.code)}</p><p>${escape(vouchers.formatDiscount(voucher))}</p>${voucher.minimumSubtotal ? `<p>Minimum order ${money(voucher.minimumSubtotal)}</p>` : ''}${voucher.endDate ? `<p>Valid through ${escape(voucher.endDate)}</p>` : ''}<small>${Number.isFinite(count.remaining) ? `${count.remaining} redemption${count.remaining === 1 ? '' : 's'} remaining` : 'Multiple use'}</small></div>${button('print', 'Print voucher', '', '')}`);
  }

  document.addEventListener('click', event => {
    const b = event.target.closest('button');
    if (!b || b.disabled) return;
    try {
      if (b.dataset.view) { view = b.dataset.view; render(); return; }
      const id = b.dataset.id;
      switch (b.dataset.action) {
        case 'page':
          listPages[b.dataset.list] = Number(b.dataset.page);
          if (b.dataset.list === 'history') renderHistory();
          else if (b.dataset.list === 'vouchers') renderVouchers();
          else renderInventoryResults();
          break;
        case 'cash-in': cashMovementForm('IN'); break;
        case 'cash-out': cashMovementForm('OUT'); break;
        case 'register-history': registerHistory(id); break;
        case 'go-register': view = 'register'; render(); break;
        case 'refund-sale': refundForm(id); break;
        case 'void-sale': refundForm(id, 'VOID'); break;
        case 'refund-receipt': refundReceipt(id); break;
        case 'new-voucher': voucherForm(); break;
        case 'edit-voucher': voucherForm(id); break;
        case 'show-voucher': showVoucher(id); break;
        case 'toggle-voucher':
          save(d => {
            d.vouchers ||= [];
            const voucher = d.vouchers.find(item => item.id === id);
            if (!voucher) throw new Error('Voucher not found.');
            voucher.status = voucher.status === 'active' ? 'inactive' : 'active';
          });
          render();
          break;
        case 'remove-voucher': appliedVoucherId = ''; renderCart(); notice('Voucher removed from the order.'); break;
        case 'filter-stock':
          inventoryStatus = id;
          listPages.inventory = 1;
          render();
          break;
        case 'take-picture':
          window.OnePOSCamera.start(b.closest('form'));
          break;
        case 'cancel-camera':
          window.OnePOSCamera.stop();
          b.closest('form').querySelector('#image-status').textContent = 'Camera closed. Your existing image is unchanged.';
          break;
        case 'capture-photo': {
          const form = b.closest('form');
          form.productImage = window.OnePOSCamera.capture();
          form.productImageId = '';
          markImageSelection(form);
          form.querySelector('#product-image-preview').innerHTML = productImagePreview({image: form.productImage, name: 'Product preview'});
          form.querySelector('#image-status').textContent = 'Picture captured. Save the product to keep it, or take another picture.';
          break;
        }
        case 'choose-sale-customer':
          customerId = id || '';
          renderCart();
          focusSearch();
          break;
        case 'clear-inventory-search': {
          managementSearch[view] = ''; managementExact[view] = false;
          listPages[view] = 1;
          const input = document.querySelector('#inventory-search');
          input.value = ''; renderInventoryResults(); input.focus(); break;
        }
        case 'select-image': {
          window.OnePOSCamera.stop();
          const preset = window.OnePOSImageCatalog.find(item => item.id === id);
          if (!preset) throw new Error('Image not found.');
          const form = b.closest('form');
          form.productImage = '';
          form.productImageId = preset.id;
          form.querySelector('#product-image-preview').innerHTML = productImagePreview({imageId: preset.id, name: preset.name});
          form.querySelector('#image-status').textContent = preset.name + ' selected. Save the product to keep it.';
          markImageSelection(form);
          break;
        }
        case 'remove-image': {
          window.OnePOSCamera.stop();
          const form = b.closest('form');
          form.productImage = '';
          form.productImageId = '';
          markImageSelection(form);
          form.querySelector('#product-image-preview').innerHTML = '';
          form.querySelector('#image-status').textContent = '';
          break;
        }
        case 'add':
          add(id);
          if (b.classList.contains('product') || b.classList.contains('quick-seller')) {
            search = '';
            const input = document.querySelector('#search');
            input.value = '';
            clearTimeout(salesScanTimer);
            renderCatalog();
            input.focus();
          }
          break;
        case 'minus': cart = cart.map(l => l.id === id ? { ...l, quantity: l.quantity - 1 } : l).filter(l => l.quantity); if (!cart.length) appliedVoucherId = ''; renderCart(); break;
        case 'clear-cart': cart = []; customerId = ''; appliedVoucherId = ''; renderCart(); break;
        case 'product': productForm(id); break;
        case 'customer': customerForm(id); break;
        case 'delete-product':
          if (!confirm('Delete this product? Historical receipts will remain.')) break;
          save(d => { d.products = d.products.filter(p => p.id !== id); });
          cart = cart.filter(l => l.id !== id); if (!cart.length) appliedVoucherId = ''; render(); break;
        case 'delete-customer':
          if (!confirm('Delete this customer? Historical receipts will remain.')) break;
          save(d => { d.customers = d.customers.filter(c => c.id !== id); });
          if (customerId === id) customerId = ''; render(); break;
        case 'stock-history': stockHistory(id); break;
        case 'stock': {
          const p = data.products.find(p => p.id === id);
          modal(`<h2>Adjust ${escape(p.name)}</h2><form data-form="stock" data-id="${id}"><label>New stock quantity<input name="stock" type="number" min="0" step="1" value="${p.stock}" required></label><label>Reason<input name="reason" maxlength="200" required></label><button>Save adjustment</button></form>`); break;
        }
        case 'checkout':
          if (!cart.length || !activeRegister()) throw new Error('Open a register and add products first.');
          {
            const totals = orderTotals();
            if (!totals.voucherResult.valid) throw new Error(totals.voucherResult.reason);
            modal(`<h2>Cash checkout</h2>${totalsRows(totals)}<form data-form="checkout" data-quoted-total="${totals.total}" data-voucher-id="${escape(appliedVoucherId)}"><label>Cash received<input name="received" type="number" min="${totals.total / 100}" step="0.01" value="${totals.total / 100}" required autofocus></label><button>Complete sale</button></form>`);
          }
          break;
        case 'receipt': receipt(id); break;
        case 'print': window.print(); break;
        case 'export': {
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `onepos-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break;
        }
        case 'restore':
          pendingRestore = null;
          modal(`<h2>Restore a backup</h2><p>Choose a JSON backup exported from TWINTECH OnePOS. The file will be checked before anything is changed.</p><label>Backup file<input id="backup-file" type="file" accept=".json,application/json"></label><p id="restore-status" role="status"></p><p class="muted">The current records stay in place unless you review the backup and confirm replacement.</p>`);
          break;
        case 'confirm-restore':
          if (!pendingRestore) throw new Error('Choose and review a valid backup first.');
          data = window.OnePOSStorage.replace(pendingRestore);
          pendingRestore = null;
          cart = []; customerId = ''; appliedVoucherId = ''; search = '';
          managementSearch.products = ''; managementSearch.inventory = '';
          managementExact.products = false; managementExact.inventory = false;
          inventoryStatus = 'all'; view = 'settings';
          dialog.close(); render(); notice('Backup restored successfully.');
          break;
      }
    } catch (error) { notice(error.message, true); if (dialog.open) alert(error.message); }
  });
  document.querySelector('#dismiss-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { window.OnePOSCamera.stop(); focusSearch(); dismissNoticeLater(); });
  // Background clicks also restore scanner focus. Editable controls keep focus
  // while being used; the customer dropdown returns focus when it closes.
  document.addEventListener('click', event => {
    if (dialog.open) return;
    if (event.target.closest('input, textarea, select, label, summary, [contenteditable="true"]')) return;
    const picker = document.querySelector('#sale-customer-picker');
    if (picker) picker.open = false;
    queueMicrotask(focusSearch);
  });
  document.addEventListener('toggle', event => {
    if (event.target.id === 'sale-customer-picker' && !event.target.open) focusSearch();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.closest('#sale-customer-picker')) {
      document.querySelector('#sale-customer-picker').open = false;
      focusSearch();
    }
  });
  document.addEventListener('input', event => {
    const refund = event.target.closest('form[data-form="refund"]');
    if (refund) updateRefundPreview(refund);
    if (event.target.id === 'inventory-search') {
      managementSearch[view] = event.target.value; managementExact[view] = false; listPages[view] = 1; renderInventoryResults();
    }
    if (event.target.id === 'voucher-code-input') {
      clearTimeout(voucherScanTimer);
      const input = event.target;
      const scanned = vouchers.normalizeCode(input.value);
      voucherScanTimer = setTimeout(() => {
        if (view !== 'pos' || dialog.open || !input.isConnected || vouchers.normalizeCode(input.value) !== scanned || !scanned) return;
        if ((data.vouchers || []).some(item => vouchers.normalizeCode(item.code) === scanned)) {
          try { applyVoucherCode(scanned); }
          catch (error) { notice(error.message, true); input.select(); }
        }
      }, 250);
    }
    if (event.target.id === 'search') {
      clearTimeout(salesScanTimer);
      search = event.target.value;
      renderCatalog();
      const input = event.target;
      const value = input.value;
      // Wait for the scanner to finish before resolving barcodes with shared prefixes.
      salesScanTimer = setTimeout(() => {
        if (view === 'pos' && !dialog.open && input.isConnected && input.value === value) addScannedProduct(input);
      }, 180);
    }
  });
  document.addEventListener('change', async event => {
    if (event.target.id === 'backup-file') {
      const input = event.target;
      const status = document.querySelector('#restore-status');
      pendingRestore = null;
      try {
        const file = input.files?.[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') throw new Error('Choose a JSON backup file.');
        if (file.size > 25 * 1024 * 1024) throw new Error('Backup file is too large to open safely (25 MB maximum).');
        const candidate = window.OnePOSStorage.inspect(JSON.parse(await file.text()));
        if (!input.isConnected) return;
        pendingRestore = candidate;
        status.innerHTML = `Backup is valid. It contains ${candidate.products.length} products, ${candidate.customers.length} customers, ${candidate.sales.length} sales, ${candidate.registers.length} register sessions, and ${(candidate.refunds || []).length} refunds. ${button('confirm-restore', 'Replace current data', '', 'danger')}`;
      } catch (error) {
        if (input.isConnected) status.textContent = error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message;
      }
      return;
    }
    if (event.target.id === 'product-category') {
      const form = event.target.form;
      const adding = event.target.value === '__new__';
      form.querySelector('#new-category-label').hidden = !adding;
      const input = form.elements.newCategory;
      input.disabled = !adding;
      input.required = adding;
      if (adding) input.focus();
    }
    if (event.target.form?.dataset.form === 'voucher') {
      const form = event.target.form;
      if (event.target.name === 'discountType') {
        const isPercent = event.target.value === 'percent';
        form.querySelector('[data-max-discount]').hidden = !isPercent;
        form.elements.maxDiscount.disabled = !isPercent;
        form.elements.discountValue.max = isPercent ? '100' : '';
        form.querySelector('[data-discount-help]').textContent = isPercent ? 'Percent of the order subtotal after product promotions.' : 'PHP off the order subtotal after product promotions.';
      }
      if (event.target.name === 'usageMode') {
        const multiple = event.target.value === 'multiple';
        form.querySelector('[data-max-uses]').hidden = !multiple;
        form.elements.maxUses.disabled = !multiple;
      }
    }
  });
  function addScannedProduct(input) {
    clearTimeout(salesScanTimer);
    const barcode = input.value.trim().toLowerCase();
    if (!barcode) return;
    const product = data.products.find(p => p.barcode && String(p.barcode).trim().toLowerCase() === barcode);
    if (!product) return; // Ordinary text searches only filter the catalog.
    try {
      add(product.id);
      search = '';
      input.value = '';
      renderCatalog();
      notice(`${product.name} added to the order.`);
    } catch (error) {
      notice(error.message, true);
      input.select();
    }
  }
  document.addEventListener('keydown', event => {
    if (event.target.id === 'voucher-code-input' && event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(voucherScanTimer);
      try { applyVoucherCode(event.target.value); }
      catch (error) { notice(error.message, true); event.target.focus(); event.target.select(); }
      return;
    }
    if (event.target.id === 'inventory-search' && event.key === 'Enter') {
      event.preventDefault();
      managementSearch[view] = event.target.value.trim();
      managementExact[view] = Boolean(managementSearch[view]);
      listPages[view] = 1;
      renderInventoryResults();
      event.target.select();
      return;
    }
    if (event.target.id !== 'search' || event.key !== 'Enter') return;
    event.preventDefault();
    addScannedProduct(event.target);
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    const id = form.dataset.id;
    try {
      switch (form.dataset.form) {
        case 'voucher': {
          const values = vouchers.validateDefinition(fields, data, id);
          save(d => {
            d.vouchers ||= [];
            const existing = d.vouchers.find(item => item.id === id);
            if (existing) Object.assign(existing, values);
            else d.vouchers.push({id: uid(), ...values, createdAt: now()});
          });
          dialog.close();
          view = 'vouchers';
          render();
          notice('Voucher saved successfully.');
          return;
        }
        case 'cash-movement': {
          const value = amount(fields.amount);
          const reason = required(fields.reason, 'Reason');
          save(d => window.OnePOSRegister.record(d, id, form.dataset.type, value, reason, form.dataset.movementId, now()));
          break;
        }
        case 'refund': {
          const fields = refundFields(form);
          const sale = data.sales.find(s => s.id === id);
          const quote = refunds.quote(data, sale, fields.quantities, fields.restock, form.dataset.type);
          required(fields.reason, 'Reason');
          if (!confirm('Record ' + money(quote.total) + ' cash returned? This cannot be undone.')) return;
          const refundId = save(d => refunds.apply(d, id, fields.quantities, fields.restock, fields.reason, form.dataset.type, form.dataset.refundId, now()));
          render(); refundReceipt(refundId); notice('Refund saved successfully.'); return;
        }
        case 'product': {
          const requestedCategory = required(fields.category === '__new__' ? fields.newCategory : fields.category, 'Category');
          const category = categories().find(c => c.toLowerCase() === requestedCategory.toLowerCase()) || requestedCategory;
          const values = { imageId: form.productImageId || '', image: form.productImage || '', name: required(fields.name, 'Name'), category, promoPercent: discountRate(fields.promoPercent || 0), barcode: fields.barcode.trim(), price: amount(fields.price, 'Price'), cost: amount(fields.cost, 'Cost') };
          Object.assign(values, promos.schedule(values.promoPercent, fields.promoStart, fields.promoEnd));
          save(d => {
            if (values.barcode && d.products.some(p => p.id !== id && p.barcode === values.barcode)) throw new Error('Barcode already exists.');
            d.categories = [...new Set([...(d.categories || []), category])];
            const p = d.products.find(p => p.id === id);
            if (p) Object.assign(p, values);
            else {
              const product = { id: uid(), ...values, stock: integer(fields.stock) };
              d.products.push(product);
              if (product.stock) d.movements.push({ id: uid(), productId: product.id, change: product.stock, reason: 'Opening stock', createdAt: now() });
            }
          }); break;
        }
        case 'stock': save(d => {
          const p = d.products.find(p => p.id === id);
          const stock = integer(fields.stock);
          d.movements.push({ id: uid(), productId: id, change: stock - p.stock, reason: required(fields.reason, 'Reason'), createdAt: now() });
          p.stock = stock;
        }); cart = cart.filter(l => l.id !== id); if (!cart.length) appliedVoucherId = ''; break;
        case 'customer': save(d => {
          const values = { name: required(fields.name, 'Name'), phone: fields.phone.trim(), email: fields.email.trim() };
          const c = d.customers.find(c => c.id === id);
          if (c) Object.assign(c, values); else d.customers.push({ id: uid(), ...values });
        }); break;
        case 'open-register': save(d => {
          if (d.registers.some(r => !r.closedAt)) throw new Error('A register is already open.');
          d.registers.push({ id: uid(), openedAt: now(), opening: amount(fields.cash), cashier: d.settings.cashier, closedAt: null });
        }); view = 'pos'; break;
        case 'close-register': {
          const closing = amount(fields.cash);
          const current = activeRegister();
          if (!current) throw new Error('No register is open.');
          const expectedCash = expected(current);
          const variance = closing - expectedCash;
          modal(`<h2>Close register?</h2><p>Review the cash count before closing this session.</p><div class="row"><span>Expected cash</span><strong>${money(expectedCash)}</strong></div><div class="row"><span>Counted cash</span><strong>${money(closing)}</strong></div><div class="row total"><span>Variance</span><strong class="${variance < 0 ? 'variance-short' : variance > 0 ? 'variance-over' : 'variance-balanced'}">${money(variance)}</strong></div><p>${variance < 0 ? 'Cash is short by ' + money(-variance) + '.' : variance > 0 ? 'Cash is over by ' + money(variance) + '.' : 'The cash count is balanced.'}</p><form data-form="confirm-close-register" data-id="${current.id}"><input type="hidden" name="closing" value="${closing}"><input type="hidden" name="expected" value="${expectedCash}"><button type="submit">Close register</button></form>`);
          document.querySelector('#dismiss-dialog').textContent = 'Cancel';
          document.querySelector('#dismiss-dialog').focus();
          return;
        }
        case 'confirm-close-register': {
          const closing = Number(fields.closing);
          if (!Number.isSafeInteger(closing) || closing < 0) throw new Error('Invalid closing cash.');
          save(d => {
            const r = d.registers.find(r => r.id === id && !r.closedAt);
            if (!r) throw new Error('This register is no longer open.');
            const cashSummary = window.OnePOSRegister.totals(d, r);
            if (cashSummary.expected !== Number(fields.expected)) throw new Error('Register cash changed. Cancel and review the cash count again.');
            Object.assign(r, {closedAt: now(), closing, expected: cashSummary.expected, cashSummary});
          });
          break;
        }
        case 'settings': save(d => {
          const vat = Number(fields.vat);
          if (fields.vat.trim() === '' || !Number.isFinite(vat) || vat < 0 || vat > 100) throw new Error('Enter a VAT rate between 0 and 100.');
          d.settings = { name: required(fields.name, 'Store name'), address: String(fields.address || '').trim(), cashier: required(fields.cashier, 'Operator name'), vat, tin: String(fields.tin || '').trim() };
        }); break;
        case 'checkout': {
          const received = amount(fields.received);
          const voucherId = form.dataset.voucherId || '';
          if (voucherId !== appliedVoucherId) throw new Error('Voucher selection changed. Review the order and try checkout again.');
          const saleId = save(d => {
            const r = d.registers.find(r => !r.closedAt);
            if (!r || !cart.length) throw new Error('An open register and products are required.');
            const items = cart.map(line => {
              const p = d.products.find(p => p.id === line.id);
              if (!p || p.stock < line.quantity) throw new Error('Stock changed. Review your order.');
              p.stock -= line.quantity;
              return { productId: p.id, name: p.name, quantity: line.quantity, price: promoPrice(p), regularPrice: p.price, promoPercent: promos.activeRate(p), cost: p.cost };
            });
            const promoDiscount = items.reduce((n, i) => n + (i.regularPrice - i.price) * i.quantity, 0);
            const gross = items.reduce((n, i) => n + i.price * i.quantity, 0);
            const voucherResult = voucherId ? vouchers.evaluate(d, voucherId, gross) : {valid: true, discount: 0, voucher: null};
            if (!voucherResult.valid) throw new Error(voucherResult.reason);
            const totals = calculateTotals(gross, voucherResult.discount, d.settings.vat);
            if (totals.total !== Number(form.dataset.quotedTotal)) throw new Error('Prices changed since checkout opened. Close checkout and review the order before paying.');
            if (received < totals.total) throw new Error('Cash received is less than the total.');
            const sale = { id: uid(), number: nextReceiptNumber(d.sales), registerId: r.id, createdAt: now(), store: d.settings.name, address: d.settings.address || '', tin: d.settings.tin || '', cashier: d.settings.cashier, customer: d.customers.find(c => c.id === customerId)?.name || 'Walk-in', items, promoDiscount, subtotal: totals.subtotal, discountPercent: 0, voucherId: voucherResult.voucher?.id || '', voucherCode: voucherResult.voucher?.code || '', voucherName: voucherResult.voucher?.name || '', voucherDiscount: totals.discount, discount: totals.discount, total: totals.total, net: totals.net, vat: totals.vat, vatRate: d.settings.vat, received, paymentMethod: 'Cash' };
            d.sales.push(sale);
            items.forEach(i => d.movements.push({ id: uid(), productId: i.productId, change: -i.quantity, reason: `Sale ${sale.number}`, createdAt: sale.createdAt }));
            return sale.id;
          });
          cart = []; customerId = ''; appliedVoucherId = ''; render(); receipt(saleId); notice('Sale completed'); return;
        }
      }
      dialog.close(); render(); notice('Save successfully');
    } catch (error) {
      notice(error.message, true);
      if (dialog.open) alert(error.message);
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === store.key || event.key === null) {
      notice('Data changed in another tab. Reload before continuing. Use one POS tab at a time.', true);
    }
  });
  try {
    data = store.load();
    if (data.products.some(p => promos.expired(p))) save(() => {});
    // CLEANUP:MIGRATION — Remove with assign-product-images.js after assignment.
    try { data = window.OnePOSAssignProductImages(store, data, window.OnePOSImageCatalog); }
    catch (error) { notice('Product images could not be assigned: ' + error.message, true); }
    render();
  }
  catch (error) { notice(error.message, true); content.innerHTML = '<div class="card"><h1>Storage unavailable</h1><p>Enable browser storage and reload. Existing records have not been replaced.</p></div>'; document.querySelectorAll('nav button').forEach(b => b.disabled = true); }

  function refreshPromoDay() {
    if (!data || document.hidden) return;
    const day = promos.today();
    if (day === promoDay) return;
    try {
      if (data.products.some(p => promos.expired(p))) save(() => {});
      if (dialog.open) {
        if (dialog.querySelector('form[data-form="checkout"]')) {
          promoDay = day; dialog.close(); render(); notice('Promo periods changed.');
        }
      } else { promoDay = day; render(); }
    } catch (error) { notice(error.message, true); }
  }
  setInterval(refreshPromoDay, 1000);
  document.addEventListener('visibilitychange', refreshPromoDay);
  window.addEventListener('focus', refreshPromoDay);

  // Retire only this application's old service worker when opening at its old address.
  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(async registrations => {
      const scope = new URL('./', location.href).href;
      for (const registration of registrations) {
        if (registration.scope === scope && registration.active?.scriptURL === new URL('sw.js', scope).href) await registration.unregister();
      }
      if ('caches' in window) for (const key of await caches.keys()) if (key.startsWith('twintech-onepos-')) await caches.delete(key);
    }).catch(() => {});
  }
})();






