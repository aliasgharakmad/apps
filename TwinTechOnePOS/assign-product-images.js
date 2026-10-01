/* CLEANUP:MIGRATION — One-time image assignment for existing coffee shop products.
   Remove this file, its script tag, and its app.js call after browser stores have applied it.
   Does not create products, overwrite images, or change stock/prices. */
window.OnePOSAssignProductImages = (store, data, catalog) => {
  const migration = 'coffee-product-images-v1';
  if (data.migrations?.includes(migration) || !data.products.length) return data;
  const groups = {
    espresso: ['Espresso'],
    coffee: ['Americano', 'Black Coffee', 'Hot Coffee'],
    latte: ['Cappuccino', 'Cafe Latte', 'Latte'],
    mocha: ['Cafe Mocha', 'Mocha', 'Hot Chocolate'],
    'iced-coffee': ['Iced Americano', 'Iced Coffee'],
    'iced-latte': ['Iced Latte', 'Caramel Macchiato'],
    matcha: ['Matcha Latte', 'Matcha'],
    water: ['Bottled Water', 'Water'],
    juice: ['Orange Juice', 'Juice', 'Iced Tea'],
    croissant: ['Butter Croissant', 'Croissant'],
    muffin: ['Blueberry Muffin', 'Muffin'],
    cookie: ['Chocolate Cookie', 'Cookie', 'Chocolate Chip Cookie'],
    cake: ['Cheesecake Slice', 'Cheesecake', 'Cake', 'Cake Slice'],
    sandwich: ['Ham & Cheese Sandwich', 'Ham and Cheese Sandwich', 'Chicken Sandwich', 'Sandwich'],
    bread: ['Bread', 'Bread Loaf'],
    donut: ['Donut', 'Doughnut'],
    beans: ['Coffee Beans'],
    'cup-s': ['Small Cup', 'Cup Small'],
    'cup-m': ['Medium Cup', 'Cup Medium'],
    'cup-l': ['Large Cup', 'Cup Large'],
    'cup-xl': ['Extra Large Cup', 'Extralarge Cup', 'Cup Extra Large']
  };
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const matches = new Map(Object.entries(groups).flatMap(([id, names]) => names.map(name => [normalize(name), id])));
  const validIds = new Set(catalog.map(image => image.id));
  return store.update(next => {
    for (const product of next.products) {
      if (product.image || product.imageId) continue;
      const imageId = matches.get(normalize(product.name));
      if (validIds.has(imageId)) product.imageId = imageId;
    }
    next.migrations = [...(next.migrations || []), migration];
  }).data;
};
