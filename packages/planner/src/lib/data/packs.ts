/**
 * Sample-data packs. The generator draws names, prices, descriptions and the
 * like from the ACTIVE pack: the generic one until a cookbook is applied, then
 * that cookbook's (same id). Every value is fixed text, so a pack is as
 * deterministic as the seed. Money is integer minor units (cents).
 */

/** What a sample product is, as the pack describes it. */
export interface PackProduct {
  name: string;
  price: number;
  description?: string;
  category?: string;
  /** `material` for things bought in (ingredients, steel); `product` for things sold. */
  productType?: 'product' | 'material' | 'assembly';
  /** Index into the pack's `locations` where this is counted; omitted: the first. */
  at?: number;
  /** How many of it a line item sells, `[min, max]`; omitted: the pack's. */
  quantity?: [number, number];
}

/** A line item: a service or part as an invoice or order would say it. */
export interface PackLine {
  description: string;
  price: number;
  /** How many a line sells, `[min, max]` (`[1, 1]`: always one); omitted: the pack's. */
  quantity?: [number, number];
}

export interface PackLocation {
  code: string;
  name: string;
  kind: string;
}

export interface SamplePack {
  id: string;
  /**
   * Rows 0-4 are what sample relations point at, so keep sellable items first.
   */
  products: readonly PackProduct[];
  /** Line descriptions that are not products (labour, fabrication, passes). */
  lines?: readonly PackLine[];
  /** Customer profile names (8). Vendors take the next five profiles. */
  customers?: readonly string[];
  vendors?: readonly string[];
  /**
   * Staff who lead events and jobs (instructors, technicians, crew leads):
   * Profiles of their own after the customers and vendors, so an organizer is
   * never a customer.
   */
  instructors?: readonly string[];
  /** Notes on documents (orders, invoices, estimates). */
  notes?: readonly string[];
  /** Notes about a customer (a member's preferences); omitted: `notes`. */
  customerNotes?: readonly string[];
  /** Notes about a vendor; omitted: `notes`. */
  vendorNotes?: readonly string[];
  /**
   * Descriptions by model name (`Event`, `EventSeries`, `EventType`, `Place`).
   * Where the pack names that model's rows, entry `n` describes name `n`.
   * Never notes: a class is not described by a member's preferences.
   */
  descriptions?: Readonly<Record<string, readonly string[]>>;
  /** Default `[min, max]` quantity of a line item; omitted: 1 to 5. */
  lineQuantity?: [number, number];
  terms?: readonly string[];
  /** Event names; entry `n` suits `eventTypes[n % 5]`. */
  eventNames?: readonly string[];
  eventTypes?: readonly string[];
  seriesNames?: readonly string[];
  /** Places events happen at, and what kinds of place they are. */
  placeNames?: readonly string[];
  placeTypes?: readonly string[];
  /** Default sales tax rate (fraction) of the cookbook; omitted: random rates. */
  taxRate?: number;
  locations?: readonly PackLocation[];
  /** Sample rows per model id, where the pack needs more than the default. */
  rowCounts?: Readonly<Record<string, number>>;
  /** Weighted picks for an enumerated field, keyed `Model.field`. */
  weights?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export const GENERIC_PACK: SamplePack = {
  id: 'generic',
  products: [
    { name: 'Canvas tote', price: 2400 },
    { name: 'Ceramic mug', price: 1800 },
    { name: 'Linen apron', price: 3600 },
    { name: 'Beeswax candle', price: 1500 },
    { name: 'Walnut cutting board', price: 5800 },
    { name: 'Wool throw blanket', price: 8900 },
    { name: 'Enamel camp cup', price: 1200 },
    { name: 'Leather notebook', price: 2900 },
  ],
  locations: [
    { code: 'MAIN', name: 'Main floor', kind: 'store' },
    { code: 'STORE', name: 'Storage room', kind: 'warehouse' },
  ],
};

const BAKERY: SamplePack = {
  id: 'bakery',
  taxRate: 0,
  products: [
    {
      name: 'Sourdough loaf',
      price: 850,
      category: 'Bread',
      productType: 'product',
      description: 'Slow-fermented, baked daily.',
      at: 0,
    },
    {
      name: 'Baguette',
      price: 450,
      category: 'Bread',
      productType: 'product',
      description: 'Crisp crust, soft crumb.',
      at: 0,
    },
    {
      name: 'Butter croissant',
      price: 400,
      category: 'Pastry',
      productType: 'product',
      description: 'Laminated with cultured butter.',
      at: 0,
    },
    {
      name: 'Pain au chocolat',
      price: 450,
      category: 'Pastry',
      productType: 'product',
      description: 'Two bars of dark chocolate.',
      at: 0,
    },
    {
      name: 'Cinnamon bun',
      price: 475,
      category: 'Pastry',
      productType: 'product',
      description: 'Cream cheese glaze.',
      at: 0,
    },
    {
      name: 'Chocolate layer cake',
      price: 4800,
      category: 'Cake',
      productType: 'product',
      description: 'Serves eight. Order a day ahead.',
      at: 1,
    },
    {
      name: 'Carrot cake slice',
      price: 650,
      category: 'Cake',
      productType: 'product',
      description: 'Walnuts and cream cheese frosting.',
      at: 1,
    },
    {
      name: 'Flat white',
      price: 450,
      category: 'Coffee',
      productType: 'product',
      description: 'Double shot, steamed milk.',
      at: 0,
    },
    {
      name: 'Bread flour, 25 kg',
      price: 3200,
      category: 'Ingredient',
      productType: 'material',
      description: 'High-protein stone-milled flour.',
      at: 2,
    },
    {
      name: 'Unsalted butter, 5 kg',
      price: 5400,
      category: 'Ingredient',
      productType: 'material',
      description: 'European-style, 82% fat.',
      at: 1,
    },
    {
      name: 'Cane sugar, 10 kg',
      description: 'Fine granulated cane sugar.',
      price: 1900,
      category: 'Ingredient',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Instant yeast, 500 g',
      description: 'Fast-acting, no proofing needed.',
      price: 1100,
      category: 'Ingredient',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Free-range eggs, tray of 30',
      description: 'Free-range, graded large.',
      price: 1300,
      category: 'Ingredient',
      productType: 'material',
      at: 1,
    },
    {
      name: 'Dark chocolate, 2 kg',
      description: 'Couverture, 64% cacao.',
      price: 3800,
      category: 'Ingredient',
      productType: 'material',
      at: 2,
    },
  ],
  customers: [
    'Corner Café',
    'Maple Street Deli',
    'Sunrise Diner',
    'Willow Bistro',
    'Harbor Coffee Roasters',
    'Anna Petrov',
    'Marcus Lee',
    'Priya Shah',
  ],
  vendors: [
    'Stonemill Flour Co.',
    'Valley Creamery',
    'Heritage Grain Mill',
    'Meadowbrook Dairy',
    'Cascade Packaging',
  ],
  notes: [
    'Deliver before 6 a.m.',
    'Standing order; confirm each week.',
    'No nuts, please. Allergy on file.',
    'Extra baguettes for the weekend.',
    'Pickup at the front counter.',
  ],
  terms: ['Net 15', 'Due on receipt', 'Net 30'],
  customerNotes: [
    'Standing order every Friday.',
    'No nuts, please. Allergy on file.',
    'Prefers pickup at the front counter.',
    'Orders extra for the weekend.',
    'Pays on the first of the month.',
  ],
  vendorNotes: [
    'Delivers before 5 a.m.',
    'Invoice arrives with the delivery.',
    'Call ahead for holiday orders.',
    'Minimum order of ten bags.',
    'Credit note owed for a short delivery.',
  ],
  lineQuantity: [1, 6],
  locations: [
    { code: 'FRONT', name: 'Front counter', kind: 'store' },
    { code: 'COOLER', name: 'Walk-in cooler', kind: 'cooler' },
    { code: 'DRY', name: 'Dry store', kind: 'warehouse' },
  ],
  rowCounts: { '@happyvertical/smrt-products:Product': 14 },
  weights: {
    'Order.status': { completed: 6, accepted: 2, sent: 1, draft: 1 },
    'WholesaleOrder.status': { completed: 5, accepted: 3, sent: 1, draft: 1 },
  },
};

const MECHANIC: SamplePack = {
  id: 'mechanic',
  taxRate: 0.0825,
  products: [
    {
      name: 'Brake pads, front set',
      description: 'Ceramic pads with hardware kit.',
      price: 8900,
      category: 'Brakes',
      productType: 'product',
    },
    {
      name: 'Oil filter',
      description: 'Spin-on filter for most cars.',
      price: 1400,
      category: 'Filters',
      productType: 'product',
    },
    {
      name: 'Spark plugs, set of 4',
      description: 'Iridium plugs, pre-gapped.',
      price: 3600,
      category: 'Ignition',
      productType: 'product',
    },
    {
      name: 'Synthetic engine oil, 5 L',
      description: 'Full synthetic, 5W-30.',
      price: 4200,
      category: 'Fluids',
      productType: 'product',
    },
    {
      name: 'Air filter',
      description: 'Pleated paper element.',
      price: 2200,
      category: 'Filters',
      productType: 'product',
    },
    {
      name: 'Wiper blades, pair',
      description: 'Beam blades, all weather.',
      price: 2400,
      category: 'Body',
      productType: 'product',
    },
    {
      name: 'Brake rotor, front',
      description: 'Vented, coated against rust.',
      price: 11500,
      category: 'Brakes',
      productType: 'product',
    },
    {
      name: 'Car battery, 12 V',
      description: 'Maintenance-free, 3-year warranty.',
      price: 14900,
      category: 'Electrical',
      productType: 'product',
    },
  ],
  lines: [
    {
      description: 'Labour: oil and filter change',
      price: 6500,
      quantity: [1, 3],
    },
    {
      description: 'Labour: brake service, per axle',
      price: 12000,
      quantity: [1, 2],
    },
    { description: 'Front brake pads', price: 8900, quantity: [1, 4] },
    { description: 'Diagnostic inspection', price: 9500, quantity: [1, 3] },
    { description: 'Spark plug replacement', price: 3600, quantity: [1, 4] },
    { description: 'Tire rotation and balance', price: 4500, quantity: [1, 2] },
    { description: 'Synthetic oil, 5 L', price: 4200, quantity: [1, 4] },
    {
      description: 'Battery test and replacement',
      price: 14900,
      quantity: [1, 1],
    },
  ],
  customers: [
    'Dana Whitfield',
    'Luis Moreno',
    'Hannah Brooks',
    'Tom Okafor',
    'Sofia Reyes',
    'Greg Patel',
    'Maya Chen',
    'Riverside Delivery Co.',
  ],
  vendors: [
    'Northside Auto Parts',
    'Acme Brake & Supply',
    'Pacific Filter Distributors',
    'GearHead Wholesale',
    'Lubricant Direct',
  ],
  notes: [
    'Customer is waiting.',
    'Check for open recalls before release.',
    'Approved by phone.',
    'Return the old parts to the customer.',
    'Warning light on since last week.',
  ],
  terms: ['Due on receipt', 'Net 15', 'Net 30'],
  customerNotes: [
    'Prefers a call over a text.',
    'Drives a company van; invoice the fleet account.',
    'Usually waits at the shop during service.',
    'Pick-up after 5 p.m. only.',
    'Keeps the service history in the glovebox.',
  ],
  vendorNotes: [
    'Same-day delivery before 10 a.m.',
    'Core charge refunded on return.',
    'Account number is on the packing slip.',
    'Backordered items ship free.',
    'Minimum order for free freight.',
  ],
  instructors: ['Ray Delgado', 'Kim Nakamura', 'Owen Pryce'],
  descriptions: {
    Event: [
      'Drain, new filter and fresh oil, with a fluid top-up.',
      'Pads, rotors and fluid checked and replaced as needed.',
      'Full safety inspection with a written report.',
      'Rotate all four tires and check pressure and tread.',
      'Scan the codes and trace the warning light.',
      'Drain, new filter and fresh oil, with a fluid top-up.',
      'Pads, rotors and fluid checked and replaced as needed.',
      'Full safety inspection with a written report.',
    ],
    EventType: [
      'Routine oil and filter change.',
      'Inspect and replace brake components.',
      'Annual safety and emissions inspection.',
      'Rotate and balance the tires.',
      'Trace faults with the scan tool.',
      'Test and replace the battery.',
      'Set toe, camber and caster.',
      'Anything else the shop agrees to take on.',
    ],
    EventSeries: [
      'Regular service on the manufacturer schedule.',
      'Winter and summer tire swaps.',
      'Recurring work for company vehicles.',
      'Repairs covered by the manufacturer.',
      'Condition check before a used car is bought.',
    ],
    Place: [
      'Lift bay for general repairs.',
      'Second lift bay.',
      'Alignment rack with laser targets.',
      'Where finished cars wait for their owners.',
      'Where parts are sold and picked up.',
    ],
  },
  eventNames: [
    'Oil change',
    'Brake service',
    'Annual inspection',
    'Tire rotation',
    'Diagnostics',
    'Oil change',
    'Brake service',
    'Annual inspection',
  ],
  eventTypes: [
    'Oil change',
    'Brake service',
    'Inspection',
    'Tire rotation',
    'Diagnostics',
    'Battery service',
    'Alignment',
    'Other',
  ],
  seriesNames: [
    'Scheduled maintenance',
    'Seasonal tire change',
    'Fleet contracts',
    'Warranty work',
    'Pre-purchase checks',
  ],
  placeNames: [
    'Service bay 1',
    'Service bay 2',
    'Alignment rack',
    'Customer pickup lot',
    'Parts counter',
  ],
  placeTypes: ['Service bay', 'Rack', 'Lot', 'Counter'],
  locations: [
    { code: 'PARTS', name: 'Parts counter', kind: 'store' },
    { code: 'BAYS', name: 'Bay storage', kind: 'warehouse' },
  ],
  weights: {
    'Order.status': { completed: 5, accepted: 3, sent: 1, draft: 1 },
    'Estimate.status': { sent: 3, accepted: 3, declined: 1, draft: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
    // Vehicle owners are retail customers.
    'Customer.customerType': { retail: 1 },
  },
};

const WELDER: SamplePack = {
  id: 'welder',
  taxRate: 0,
  products: [
    {
      name: 'Flat bar 50 x 6 mm, 6 m',
      description: 'Mild steel, cut to length on request.',
      price: 4800,
      category: 'Steel stock',
      productType: 'material',
    },
    {
      name: 'Square tube 40 x 40 mm, 6 m',
      description: 'Mild steel hollow section.',
      price: 9200,
      category: 'Steel stock',
      productType: 'material',
    },
    {
      name: 'Steel plate 6 mm, 4 x 8 ft',
      description: 'Hot-rolled mild steel sheet.',
      price: 21500,
      category: 'Steel stock',
      productType: 'material',
    },
    {
      name: 'Angle iron 50 x 50 mm, 6 m',
      description: 'Equal-leg mild steel angle.',
      price: 7400,
      category: 'Steel stock',
      productType: 'material',
    },
    {
      name: 'Round bar 20 mm, 3 m',
      description: 'Hot-rolled mild steel round.',
      price: 3900,
      category: 'Steel stock',
      productType: 'material',
    },
    {
      name: 'Argon/CO2 shielding gas cylinder',
      description: 'Argon and CO2 mix for MIG welding.',
      price: 6800,
      category: 'Gas',
      productType: 'material',
      at: 1,
    },
    {
      name: 'MIG wire ER70S-6, 15 kg spool',
      description: 'Copper-coated solid MIG wire.',
      price: 7900,
      category: 'Consumables',
      productType: 'material',
      at: 1,
    },
    {
      name: 'Welding rods E7018, 5 kg',
      description: 'Low-hydrogen stick electrodes.',
      price: 3400,
      category: 'Consumables',
      productType: 'material',
      at: 1,
    },
  ],
  lines: [
    {
      description: 'Swing gate, fabricated and installed',
      price: 185000,
      quantity: [1, 1],
    },
    { description: 'Stair railing, 3 m run', price: 94000, quantity: [1, 2] },
    { description: 'Trailer frame repair', price: 62000, quantity: [1, 1] },
    { description: 'Custom bracket set (4)', price: 18000, quantity: [1, 3] },
    { description: 'Site welding, per hour', price: 9500, quantity: [2, 8] },
    { description: 'Powder coat finish', price: 32000, quantity: [1, 1] },
    { description: 'Delivery and site setup', price: 8500, quantity: [1, 1] },
    {
      description: 'Fence post replacement, each',
      price: 14000,
      quantity: [2, 6],
    },
  ],
  customers: [
    'Ridgeline Construction',
    'Harbor Builders',
    'Summit Roofing',
    'Oakdale Farms',
    'Granite Peak Contracting',
    'Nolan Excavation',
    'Bluewater Marine',
    'Hartley Property Group',
  ],
  vendors: [
    'Continental Steel Supply',
    'Western Metals Depot',
    'Pro Weld Gas & Gear',
    'Ironworks Wholesale',
    'Allied Fasteners',
  ],
  notes: [
    'Measure on site before cutting.',
    'Customer supplies the gate posts.',
    'Hot work permit required.',
    'Galvanise after fabrication.',
    'Access through the rear lane only.',
  ],
  terms: ['50% deposit, balance on completion', 'Net 30', 'Due on completion'],
  customerNotes: [
    'Site foreman is the contact for access.',
    'Pays by cheque, thirty days.',
    'Prefers quotes by email.',
    'Repeat customer; same crew each time.',
    'Needs a purchase order number on invoices.',
  ],
  vendorNotes: [
    'Cut lengths ready next morning.',
    'Mill certificates come with each order.',
    'Cylinder rental is billed monthly.',
    'Delivers Tuesdays and Fridays.',
    'Minimum order for free delivery.',
  ],
  instructors: ['Frank Dillard', 'Rosa Quintero', 'Jed Harlan'],
  descriptions: {
    Event: [
      'Measure the opening and check the access on site.',
      'Walk the job with the customer and agree the scope.',
      'Crew delivers, fits and finishes the work.',
      'Return to repair the fault under the original quote.',
      'Walk the finished job with the customer.',
      'Measure the opening and check the access on site.',
      'Walk the job with the customer and agree the scope.',
      'Crew delivers, fits and finishes the work.',
    ],
    EventType: [
      'Measure up before a quote.',
      'Walk through a quote with the customer.',
      'Fit finished work on site.',
      'Return to fix a fault.',
      'Sign-off with the customer.',
      'Drop finished work at the customer.',
      'Customer collects from the shop.',
      'Anything else the shop agrees to take on.',
    ],
    EventSeries: [
      'Site visits that lead to a written quote.',
      'Crews booked for fitting days.',
      'Return visits for repairs.',
      'Sign-off walks at the end of a job.',
      'Scheduled trips with finished work.',
    ],
    Place: [
      'Wherever the work is to be fitted.',
      'Where work is cut, welded and finished.',
      'Outdoor space for loading and staging.',
      'Where stock is collected from the supplier.',
      'Cabin for paperwork on large jobs.',
    ],
  },
  eventNames: [
    'Site measure',
    'Quote walk-through',
    'Install day',
    'Repair call-out',
    'Final inspection',
    'Site measure',
    'Quote walk-through',
    'Install day',
  ],
  eventTypes: [
    'Site measure',
    'Quote walk-through',
    'Install',
    'Repair call-out',
    'Final inspection',
    'Delivery',
    'Pickup',
    'Other',
  ],
  seriesNames: [
    'Estimates and site measures',
    'Install crews',
    'Repair call-outs',
    'Final inspections',
    'Delivery runs',
  ],
  placeNames: [
    'Customer site',
    'Fabrication shop',
    'Yard and loading dock',
    'Supplier pickup',
    'Job site office',
  ],
  placeTypes: ['Job site', 'Workshop', 'Yard', 'Supplier'],
  locations: [
    { code: 'RACK', name: 'Steel rack', kind: 'warehouse' },
    { code: 'GAS', name: 'Gas cage', kind: 'cage' },
  ],
  weights: {
    'Order.status': { completed: 4, accepted: 3, sent: 1, draft: 1 },
    'Estimate.status': { sent: 3, accepted: 3, declined: 1, draft: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
  },
};

const YOGA: SamplePack = {
  id: 'yoga-studio',
  taxRate: 0,
  products: [
    {
      name: 'Cork yoga mat',
      description: 'Natural cork, non-slip.',
      price: 7800,
      category: 'Mats',
      productType: 'product',
    },
    {
      name: 'Yoga blocks, pair',
      description: 'Dense foam, light and firm.',
      price: 2400,
      category: 'Props',
      productType: 'product',
    },
    {
      name: 'Cotton yoga strap',
      description: 'Adjustable D-ring strap.',
      price: 1500,
      category: 'Props',
      productType: 'product',
    },
    {
      name: 'Insulated water bottle',
      description: 'Keeps water cold all class.',
      price: 3200,
      category: 'Bottles',
      productType: 'product',
    },
    {
      name: 'Bolster',
      description: 'Firm support for restorative poses.',
      price: 6400,
      category: 'Props',
      productType: 'product',
    },
    {
      name: 'Lavender eye pillow',
      description: 'Weighted, with flax and lavender.',
      price: 1800,
      category: 'Wellness',
      productType: 'product',
    },
    {
      name: 'Meditation cushion',
      description: 'Buckwheat-filled zafu.',
      price: 5200,
      category: 'Wellness',
      productType: 'product',
    },
    {
      name: 'Studio tote bag',
      description: 'Roomy canvas tote.',
      price: 2800,
      category: 'Apparel',
      productType: 'product',
    },
  ],
  lines: [
    {
      description: 'Monthly unlimited membership',
      price: 12900,
      quantity: [1, 1],
    },
    { description: '10-class pack', price: 17000, quantity: [1, 1] },
    { description: 'Drop-in class', price: 2200, quantity: [1, 3] },
    { description: 'Private session, 60 min', price: 9000, quantity: [1, 2] },
    { description: '6-week beginners series', price: 14400, quantity: [1, 1] },
    { description: 'Workshop ticket', price: 4500, quantity: [1, 2] },
    { description: 'Mat rental', price: 300, quantity: [1, 3] },
    { description: 'Teacher training deposit', price: 50000, quantity: [1, 1] },
  ],
  customers: [
    'Emma Larsen',
    'Noah Fischer',
    'Ava Mehta',
    'Liam O’Connor',
    'Sofia Rinaldi',
    'Ethan Park',
    'Mia Tanaka',
    'Olivia Brandt',
  ],
  vendors: [
    'Lotus Yoga Supply',
    'Evergreen Mats',
    'Pure Tea Co.',
    'Sunrise Apparel',
    'Calm Candle Works',
  ],
  notes: [
    'Paid at the front desk.',
    'Includes mat rental.',
    'Renews on the first of the month.',
    'Class pass applied.',
    'Booked as a gift.',
  ],
  terms: ['Due on receipt', 'Net 15', 'Monthly, auto-renewing'],
  customerNotes: [
    'Prefers the back row near the window.',
    'Recovering from a knee injury; offer modifications.',
    'Joined through the summer promotion.',
    'Pays by card on the first of the month.',
    'Interested in the teacher training.',
  ],
  vendorNotes: [
    'Free shipping over $500.',
    'Allow two weeks for custom colours.',
    'Net 30 after delivery.',
    'Samples sent on request.',
    'Reorders by email on the first of the month.',
  ],
  instructors: ['Priya Raman', 'Daniel Okoye', 'Hana Sato', 'Marco Bellini'],
  descriptions: {
    Event: [
      'Flowing breath-led practice that builds heat steadily.',
      'Slow, grounding practice with long holds.',
      'Heated room, steady pace, plenty of water.',
      'Gentle, alignment-focused classical postures.',
      'Supported poses and long rests to unwind.',
      'Strong, athletic flow for experienced students.',
      'Longer yin holds for the hips and spine.',
      'Sixty minutes in the heat, a little faster.',
    ],
    EventType: [
      'Linked movement and breath.',
      'Passive floor poses held for minutes.',
      'Practice in a heated room.',
      'Slower, classical postures.',
      'Props and rest to restore.',
      'Safe, supported practice for expecting mothers.',
      'Seated stillness and guided breath.',
      'A longer session on a single theme.',
    ],
    EventSeries: [
      'Six weeks of foundations for new students.',
      'Eight mornings of steady flow.',
      'A slow Sunday class, week after week.',
      'A weekend of practice around the longest day.',
      'The 200-hour course for future teachers.',
    ],
    Place: [
      'Our main room with sprung floors.',
      'Smaller room for workshops and private lessons.',
      'Open-air deck for summer classes.',
      'Tea, books and a place to wait.',
      'Large hall for retreats and trainings.',
    ],
  },
  lineQuantity: [1, 2],
  eventNames: [
    'Vinyasa Flow',
    'Yin Yoga',
    'Hot Yoga',
    'Gentle Hatha',
    'Restorative Evening',
    'Power Vinyasa',
    'Deep Yin',
    'Hot Yoga 60',
  ],
  eventTypes: [
    'Vinyasa',
    'Yin',
    'Hot yoga',
    'Hatha',
    'Restorative',
    'Prenatal',
    'Meditation',
    'Workshop',
  ],
  seriesNames: [
    '6-week beginners',
    'Morning flow, 8 weeks',
    'Restorative Sundays',
    'Summer solstice weekend',
    'Teacher training, 200 h',
  ],
  placeNames: [
    'Studio A',
    'Studio B',
    'Garden terrace',
    'Lobby lounge',
    'Retreat hall',
  ],
  placeTypes: ['Studio', 'Outdoor', 'Lounge', 'Hall'],
  locations: [
    { code: 'DESK', name: 'Front desk', kind: 'store' },
    { code: 'CLOSET', name: 'Storage closet', kind: 'warehouse' },
  ],
  weights: {
    'Event.status': { scheduled: 6, completed: 3, cancelled: 1 },
    'Customer.customerType': { retail: 1 },
    'Agreement.status': { accepted: 6, sent: 1, completed: 2, cancelled: 1 },
  },
};

/** The packs that ship with cookbooks, by cookbook id. */
export const COOKBOOK_PACKS: Readonly<Record<string, SamplePack>> = {
  [BAKERY.id]: BAKERY,
  [MECHANIC.id]: MECHANIC,
  [WELDER.id]: WELDER,
  [YOGA.id]: YOGA,
};

let active: SamplePack = GENERIC_PACK;

/** The pack the generator reads right now. */
export function getSamplePack(): SamplePack {
  return active;
}

/**
 * Switch the pack to a cookbook's (unknown or null: the generic one). Rows
 * already generated are not touched; the data source's `reset` regenerates.
 */
export function setSamplePack(
  cookbookId: string | null | undefined,
): SamplePack {
  active =
    (cookbookId ? COOKBOOK_PACKS[cookbookId] : undefined) ?? GENERIC_PACK;
  return active;
}

let taxRateOverride: number | undefined;

/**
 * The app's own tax-rate setting, when it states one: sample line items use it
 * instead of the pack's. Takes effect when sample rows are next generated.
 */
export function setSampleTaxRate(rate: number | undefined): void {
  taxRateOverride = rate;
}

/** The sample tax rate: the app's setting, else the pack's (omitted: random). */
export function getSampleTaxRate(): number | undefined {
  return taxRateOverride ?? active.taxRate;
}
