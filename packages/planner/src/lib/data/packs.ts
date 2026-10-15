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

const LANDSCAPING: SamplePack = {
  id: 'landscaping',
  taxRate: 0.06,
  products: [
    {
      name: 'Hardwood mulch, per cubic yard',
      description: 'Double-shredded, natural brown.',
      price: 4200,
      category: 'Mulch and soil',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Screened topsoil, per cubic yard',
      description: 'Screened to half an inch, no stones.',
      price: 3800,
      category: 'Mulch and soil',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Sod, per pallet',
      description: 'Tall fescue blend, 450 sq ft.',
      price: 28500,
      category: 'Turf',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Paver stones, per sq ft',
      description: 'Tumbled concrete pavers, grey blend.',
      price: 650,
      category: 'Hardscape',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Boxwood shrub, 3 gallon',
      description: 'Evergreen, holds a clipped shape.',
      price: 4500,
      category: 'Plants',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Perennials, flat of 12',
      description: 'Mixed sun perennials in 4-inch pots.',
      price: 5400,
      category: 'Plants',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Lawn fertilizer, 50 lb bag',
      description: 'Slow-release granular, covers 12,000 sq ft.',
      price: 6200,
      category: 'Lawn care',
      productType: 'product',
      at: 1,
    },
    {
      name: 'Drip irrigation kit',
      description: 'Tubing, emitters and timer for one bed.',
      price: 8900,
      category: 'Irrigation',
      productType: 'product',
      at: 1,
    },
  ],
  lines: [
    { description: 'Mowing, per visit', price: 5500, quantity: [1, 4] },
    { description: 'Spring clean-up', price: 32500, quantity: [1, 1] },
    {
      description: 'Mulch installed, per cubic yard',
      price: 9500,
      quantity: [2, 8],
    },
    {
      description: 'Irrigation repair, per hour',
      price: 8500,
      quantity: [1, 4],
    },
    { description: 'Hedge trimming', price: 18000, quantity: [1, 2] },
    {
      description: 'Sod installation, per pallet',
      price: 42000,
      quantity: [1, 4],
    },
    { description: 'Design consultation', price: 15000, quantity: [1, 1] },
    { description: 'Snow plowing, per visit', price: 7500, quantity: [1, 4] },
  ],
  customers: [
    'Carol Jensen',
    'Mike Delaney',
    'Angela Ruiz',
    'Steve Kowalski',
    'Denise Thompson',
    'Birchwood Property Management',
    'Fox Hollow Homeowners Association',
    'Grace Lutheran Church',
  ],
  vendors: [
    'Green Valley Nursery',
    'Ridge Stone & Mulch Yard',
    'Clearwater Irrigation Supply',
    'Hilltop Equipment Sales',
    'Prairie Seed & Fertilizer',
  ],
  notes: [
    'Gate code is on the customer record.',
    'Dog in the back yard; close the gate.',
    'Haul away all clippings and debris.',
    'Price assumes two crew for one day.',
    'Leave the invoice in the mailbox.',
  ],
  terms: ['Net 15', 'Due on receipt', 'Net 30'],
  customerNotes: [
    'Mow on Thursdays; no visits before 8 a.m.',
    'Bills go to the property manager, not the tenant.',
    'Wants the beds edged every visit.',
    'Irrigation controller is in the garage.',
    'Board approves anything over $2,000.',
  ],
  vendorNotes: [
    'Plant material guaranteed for one season.',
    'Bulk mulch loaded by the yard; bring a tarp.',
    'Parts counter opens at 6:30 a.m.',
    'Mower service takes a week in spring.',
    'Early-order discount through February.',
  ],
  instructors: ['Jorge Castillo', 'Brett Hanlon', 'Tasha Williams'],
  descriptions: {
    Event: [
      'Mow, trim and blow off the walks.',
      'Rake out the beds, cut back perennials and haul debris.',
      'Edge the beds and spread fresh mulch.',
      'Run each zone, adjust heads and fix leaks.',
      'Thin and shape the trees before the leaves come in.',
      'Mow, trim and blow off the walks.',
      'Rake out the beds, cut back perennials and haul debris.',
      'Edge the beds and spread fresh mulch.',
    ],
    EventType: [
      'Routine cut, trim and blow-off.',
      'Bed clean-up at the start of the season.',
      'Edge beds and spread mulch.',
      'Test and adjust the sprinkler system.',
      'Prune trees and large shrubs.',
      'Build patios, walks and walls.',
      'Plow and salt after a snowfall.',
      'Walk the property and plan the work.',
    ],
    EventSeries: [
      'Weekly mowing on a set route.',
      'Bed clean-ups in April and November.',
      'Plowing whenever snow passes two inches.',
      'Five fertilizer rounds from spring to fall.',
      'Turn the irrigation on in May and blow it out in October.',
    ],
    Place: [
      'A customer yard or grounds.',
      'Where mulch, soil and stone are piled.',
      'Where plants are picked up before a job.',
      'Large commercial grounds with several buildings.',
      'Where quotes are written and calls are taken.',
    ],
  },
  lineQuantity: [1, 4],
  eventNames: [
    'Weekly mowing',
    'Spring clean-up',
    'Mulch install',
    'Irrigation check',
    'Tree pruning',
    'Weekly mowing',
    'Spring clean-up',
    'Mulch install',
  ],
  eventTypes: [
    'Mowing',
    'Spring clean-up',
    'Mulch install',
    'Irrigation check',
    'Tree pruning',
    'Hardscape',
    'Snow removal',
    'Consultation',
  ],
  seriesNames: [
    'Weekly mowing routes',
    'Spring and fall clean-ups',
    'Snow contracts',
    'Fertilizer program',
    'Irrigation start-up and shut-down',
  ],
  placeNames: [
    'Customer property',
    'Materials yard',
    'Nursery',
    'Commercial campus',
    'Office',
  ],
  placeTypes: ['Residential', 'Commercial', 'Yard', 'Office'],
  locations: [
    { code: 'YARD', name: 'Materials yard', kind: 'yard' },
    { code: 'TRUCK', name: 'Crew truck', kind: 'vehicle' },
  ],
  weights: {
    'Order.status': { completed: 5, accepted: 3, sent: 1, draft: 1 },
    'Estimate.status': { sent: 3, accepted: 3, declined: 1, draft: 1 },
    'Agreement.status': { accepted: 6, sent: 1, completed: 2, cancelled: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
    // Homeowners are retail; property managers buy on account.
    'Customer.customerType': { retail: 5, wholesale: 3 },
  },
};

const SALON: SamplePack = {
  id: 'salon',
  taxRate: 0.07,
  products: [
    {
      name: 'Moisture shampoo, 300 ml',
      description: 'Sulfate-free, for dry or coloured hair.',
      price: 2800,
      category: 'Hair care',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Moisture conditioner, 300 ml',
      description: 'Rinse-out conditioner, light hold.',
      price: 3000,
      category: 'Hair care',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Pomade, 100 g',
      description: 'Medium hold, natural shine.',
      price: 2400,
      category: 'Styling',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Hair oil, 50 ml',
      description: 'Argan blend for ends and frizz.',
      price: 3600,
      category: 'Treatment',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Heat protectant spray, 200 ml',
      description: 'Shields hair to 230 C.',
      price: 2600,
      category: 'Styling',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Styling clay, 100 g',
      description: 'Strong hold, matte finish.',
      price: 2600,
      category: 'Styling',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Dry shampoo, 250 ml',
      description: 'Absorbs oil between washes.',
      price: 2200,
      category: 'Hair care',
      productType: 'product',
      at: 1,
    },
    {
      name: 'Beard oil, 30 ml',
      description: 'Cedar and citrus, softens the beard.',
      price: 2000,
      category: 'Barber',
      productType: 'product',
      at: 1,
    },
  ],
  lines: [
    { description: "Women's cut and finish", price: 7500, quantity: [1, 1] },
    { description: "Men's cut", price: 4000, quantity: [1, 1] },
    { description: 'Full colour', price: 12500, quantity: [1, 1] },
    { description: 'Partial highlights', price: 14000, quantity: [1, 1] },
    { description: 'Blow-dry', price: 4500, quantity: [1, 1] },
    { description: 'Beard trim', price: 2500, quantity: [1, 1] },
    { description: "Kids' cut", price: 3000, quantity: [1, 2] },
    {
      description: 'Deep conditioning treatment',
      price: 3500,
      quantity: [1, 1],
    },
  ],
  customers: [
    'Rachel Donnelly',
    'Kevin Oyelaran',
    'Jasmine Torres',
    'Brian Whitaker',
    'Lena Hoffman',
    'Andre Beaulieu',
    'Megan Choi',
    'Patrick Nolan',
  ],
  vendors: [
    'Northstar Salon Supply',
    'Chroma Colour Co.',
    'Fresh Fold Towel Service',
    'Studio Line Salon Furniture',
    'Edgeworks Shear Sharpening',
  ],
  notes: [
    'Paid at the front desk.',
    'Retail added to the ticket at checkout.',
    'Tip left in cash.',
    'Gift card applied.',
    'Rebooked before leaving.',
  ],
  terms: ['Due on receipt', 'Net 15', 'Prepaid package'],
  customerNotes: [
    'Allergic to PPD; patch test before colour.',
    'Likes the back tapered short, longer on top.',
    'Formula card is in the colour bar drawer.',
    'Prefers Saturday mornings with the same stylist.',
    'Brings her two kids for cuts every eight weeks.',
  ],
  vendorNotes: [
    'Orders over $300 ship free.',
    'Rep visits the first Tuesday of the month.',
    'Towels swapped every Monday.',
    'Chair parts take three weeks.',
    'Shears picked up and returned the same week.',
  ],
  instructors: [
    'Nicole Ferreira',
    'Darnell Hayes',
    'Sam Lindqvist',
    'Yuki Mori',
  ],
  descriptions: {
    Event: [
      'Consult, cut and a finished style.',
      'Root touch-up or an all-over change.',
      'Foils around the face and part line.',
      'Wash and a round-brush finish.',
      'Shape the beard with clippers and a razor edge.',
      'Consult, cut and a finished style.',
      'Root touch-up or an all-over change.',
      'Foils around the face and part line.',
    ],
    EventType: [
      'Cut and finish for any length.',
      'Single-process colour, roots or all over.',
      'Foil highlights, partial or full.',
      'Wash and style, no cut.',
      'Clipper and razor beard shaping.',
      'A quick cut for children under twelve.',
      'Smoothing treatment, about three hours.',
      'Talk through a change before booking it.',
    ],
    EventSeries: [
      'The same slot every six weeks.',
      'No bookings; first come, first served.',
      'Hair for the bride and her party on the day.',
      'Root touch-ups and glosses between full colours.',
      'Discounted cuts for students after 5 p.m.',
    ],
    Place: [
      'First chair by the window.',
      'Second chair, nearest the basins.',
      'Where colour is mixed and applied.',
      'Two reclining basins at the back.',
      'Front desk, retail shelf and waiting area.',
    ],
  },
  lineQuantity: [1, 2],
  eventNames: [
    'Cut and finish',
    'Root colour',
    'Face-frame highlights',
    'Wash and blow-dry',
    'Beard trim',
    'Cut and finish',
    'Root colour',
    'Face-frame highlights',
  ],
  eventTypes: [
    'Haircut',
    'Colour',
    'Highlights',
    'Blow-dry',
    'Beard trim',
    "Kids' cut",
    'Keratin treatment',
    'Consultation',
  ],
  seriesNames: [
    'Standing six-week appointments',
    'Saturday walk-ins',
    'Bridal parties',
    'Colour maintenance',
    'Student evenings',
  ],
  placeNames: ['Chair 1', 'Chair 2', 'Colour bar', 'Wash basins', 'Reception'],
  placeTypes: ['Chair', 'Colour bar', 'Basins', 'Reception'],
  locations: [
    { code: 'RETAIL', name: 'Retail shelf', kind: 'store' },
    { code: 'BACKBAR', name: 'Backbar', kind: 'warehouse' },
  ],
  weights: {
    'Order.status': { completed: 7, accepted: 1, sent: 1, draft: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
    'Customer.customerType': { retail: 1 },
    'Payment.method': { credit_card: 7, cash: 2, other: 1 },
  },
};

const ROASTER: SamplePack = {
  id: 'roaster',
  taxRate: 0,
  products: [
    {
      name: 'House espresso, 12 oz',
      description: 'Medium-dark blend for espresso and milk drinks.',
      price: 1700,
      category: 'Roasted coffee',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Ethiopia Yirgacheffe, 12 oz',
      description: 'Washed single origin, light roast.',
      price: 2100,
      category: 'Roasted coffee',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Colombia Huila, 12 oz',
      description: 'Washed single origin, medium roast.',
      price: 1900,
      category: 'Roasted coffee',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Decaf Colombia, 12 oz',
      description: 'Sugarcane process decaf, medium roast.',
      price: 1900,
      category: 'Roasted coffee',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Harvest blend, 12 oz',
      description: 'Seasonal blend; changes with the crop.',
      price: 1800,
      category: 'Roasted coffee',
      productType: 'product',
      at: 0,
    },
    {
      name: 'House espresso, 5 lb',
      description: 'Cafe bag of the house espresso.',
      price: 7800,
      category: 'Roasted coffee',
      productType: 'product',
      at: 1,
    },
    {
      name: 'Cold brew concentrate, 32 oz',
      description: 'Steeped 18 hours; dilute one to one.',
      price: 1600,
      category: 'Cold brew',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Pour-over kit',
      description: 'Dripper, server, filters and a 12 oz bag.',
      price: 5200,
      category: 'Brewing gear',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Ethiopia green, 60 kg bag',
      description: 'Washed Yirgacheffe, grade 1.',
      price: 62000,
      category: 'Green coffee',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Colombia green, 70 kg bag',
      description: 'Washed Huila, supremo screen.',
      price: 58000,
      category: 'Green coffee',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Brazil green, 60 kg bag',
      description: 'Natural process, Cerrado; blend base.',
      price: 42000,
      category: 'Green coffee',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Guatemala green, 69 kg bag',
      description: 'Washed Huehuetenango, SHB.',
      price: 56000,
      category: 'Green coffee',
      productType: 'material',
      at: 2,
    },
    {
      name: 'Decaf green, 70 kg bag',
      description: 'Colombian, sugarcane process.',
      price: 64000,
      category: 'Green coffee',
      productType: 'material',
      at: 2,
    },
    {
      name: '12 oz valve bags, case of 500',
      description: 'Kraft bags with one-way valve and tin tie.',
      price: 16500,
      category: 'Packaging',
      productType: 'material',
      at: 1,
    },
  ],
  customers: [
    'Lantern Street Cafe',
    'Birchwood Bakery',
    'The Daily Grind',
    'Fieldstone Market',
    'Harbor View Bistro',
    'Claire Donnelly',
    'Omar Haddad',
    'Jenna Kowalski',
  ],
  vendors: [
    'Highland Green Coffee Importers',
    'Equator Trading Co.',
    'Pacific Rim Coffee Imports',
    'Northgate Packaging Supply',
    'Drum & Flame Roaster Service',
  ],
  notes: [
    'Deliver Tuesday with the bread order.',
    'Whole bean; they grind in house.',
    'Standing order; confirm the Friday before.',
    'Ground for drip, medium.',
    'Roasted two days before shipping.',
  ],
  terms: ['Net 30', 'Due on receipt', 'Net 15'],
  customerNotes: [
    'Delivery days are Tuesday and Friday.',
    'Takes the house espresso in 5 lb bags only.',
    'Prefers whole bean, light roasts.',
    'Standing order of ten cases a month.',
    'Wants cupping samples before each seasonal change.',
  ],
  vendorNotes: [
    'Container arrives in March; samples sent ahead.',
    'Spot lots ship from the warehouse in a week.',
    'Pre-ship samples on request.',
    'Minimum order of five cases.',
    'Services the drum roaster every six months.',
  ],
  lineQuantity: [1, 12],
  locations: [
    { code: 'SHELF', name: 'Retail shelf', kind: 'store' },
    { code: 'ROAST', name: 'Roastery floor', kind: 'warehouse' },
    { code: 'GREEN', name: 'Green coffee store', kind: 'warehouse' },
  ],
  rowCounts: { '@happyvertical/smrt-products:Product': 14 },
  weights: {
    'WholesaleOrder.status': { completed: 5, accepted: 3, sent: 1, draft: 1 },
    'Order.status': { completed: 6, accepted: 2, sent: 1, draft: 1 },
    'ProductionOrder.status': { completed: 6, accepted: 3, draft: 1 },
    'Customer.customerType': { wholesale: 5, dtc: 2, retail: 1 },
  },
};

const EQUIPMENT_RENTAL: SamplePack = {
  id: 'equipment-rental',
  taxRate: 0.08,
  products: [
    {
      name: 'Mini excavator, 1.7 t',
      description: 'Tracked mini excavator with two buckets; per day.',
      price: 28500,
      category: 'Earthmoving',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Plate compactor',
      description: 'Petrol plate compactor, 90 kg; per day.',
      price: 7500,
      category: 'Compaction',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Towable generator, 25 kVA',
      description: 'Diesel generator on a road trailer; per day.',
      price: 19500,
      category: 'Power',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Scissor lift, 19 ft',
      description: 'Electric slab scissor lift; per day.',
      price: 16500,
      category: 'Access',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Concrete mixer, 9 cu ft',
      description: 'Towable petrol mixer; per day.',
      price: 8900,
      category: 'Concrete',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Pressure washer, 4000 psi',
      description: 'Petrol hot-water washer with hose; per day.',
      price: 9500,
      category: 'Cleaning',
      productType: 'product',
      at: 1,
    },
    {
      name: 'Walk-behind trencher',
      description: 'Cuts a 4 in trench to 36 in deep; per day.',
      price: 21000,
      category: 'Earthmoving',
      productType: 'product',
      at: 0,
    },
    {
      name: 'Scaffold tower, 20 ft',
      description: 'Aluminium tower with deck and rails; per day.',
      price: 6500,
      category: 'Access',
      productType: 'product',
      at: 1,
    },
  ],
  lines: [
    { description: 'Mini excavator, per day', price: 28500, quantity: [1, 5] },
    {
      description: 'Scissor lift, weekly rate',
      price: 66000,
      quantity: [1, 2],
    },
    { description: 'Delivery and pickup', price: 15000, quantity: [1, 1] },
    { description: 'Damage waiver', price: 3500, quantity: [1, 1] },
    { description: 'Fuel refill', price: 4500, quantity: [1, 3] },
    { description: 'Operator, per hour', price: 8500, quantity: [2, 8] },
    { description: 'Cleaning fee', price: 7500, quantity: [1, 1] },
    { description: 'Late return, per day', price: 12000, quantity: [1, 3] },
  ],
  customers: [
    'Cedar Ridge Contracting',
    'Baxter & Sons Builders',
    'Greenway Landscaping',
    'Brightline Event Co.',
    'Parkside Property Management',
    'Dale Hutchins',
    'Renee Alvarado',
    'Kevin Osei',
  ],
  vendors: [
    'Midwest Equipment Dealers',
    'Heavy Parts Distribution',
    'Roadrunner Tire Service',
    'Valley Fuel Supply',
    'Hitch & Hydraulics Shop',
  ],
  notes: [
    'Deposit held on card until return.',
    'Return with a full tank or pay the refill.',
    'Deliver to the site gate; call the foreman.',
    'Operator booked for the first morning.',
    'Extended a second week by phone.',
  ],
  terms: ['Deposit on pickup, balance on return', 'Due on return', 'Net 30'],
  customerNotes: [
    'Account customer; invoice the office monthly.',
    'Needs a purchase order number on every rental.',
    'Picks up Saturday mornings in a half-ton truck.',
    'First-time renter; walk through the controls.',
    'Keeps a scissor lift on long-term hire.',
  ],
  vendorNotes: [
    'Parts arrive next day if ordered before noon.',
    'Services the fleet under the maintenance contract.',
    'Comes to the yard for tyre changes.',
    'Fills the bulk tank every Monday.',
    'Rebuilds hydraulic cylinders in a week.',
  ],
  instructors: ['Troy Bannister', 'Marisol Vega', 'Curtis Lang'],
  descriptions: {
    Event: [
      'Customer collects the machine at the counter.',
      'Machine checked, fuel and hours noted.',
      'Truck drops the machine at the site.',
      'Truck picks the machine up from the site.',
      'Oil, filters and greasing on the hour meter.',
      'Customer collects the machine at the counter.',
      'Machine checked, fuel and hours noted.',
      'Truck drops the machine at the site.',
    ],
    EventType: [
      'Customer collects from the yard.',
      'Customer brings the machine back.',
      'We deliver to the site.',
      'We collect from the site.',
      'Routine servicing on the hour meter.',
      'Safety inspection with a written record.',
      'Delivery to an unattended site.',
      'Show a customer how the machine works.',
    ],
    EventSeries: [
      'Servicing on the hour meter across the fleet.',
      'Delivery runs each week to regular sites.',
      'Annual safety inspections of lifts and trailers.',
      'Check-ins on machines out longer than a month.',
      'Saturday morning pickups for weekend hires.',
    ],
    Place: [
      'Where the fleet is parked and loaded.',
      'Where machines are serviced and repaired.',
      'Wherever the customer is working.',
      'Where machines are cleaned on return.',
      'Where paperwork and deposits are done.',
    ],
  },
  lineQuantity: [1, 7],
  eventNames: [
    'Counter pickup',
    'Equipment return',
    'Site delivery',
    'Site collection',
    'Scheduled service',
    'Counter pickup',
    'Equipment return',
    'Site delivery',
  ],
  eventTypes: [
    'Pickup',
    'Return',
    'Delivery',
    'Collection',
    'Service',
    'Inspection',
    'Site drop-off',
    'Demo',
  ],
  seriesNames: [
    'Scheduled servicing',
    'Weekly delivery runs',
    'Annual inspections',
    'Long-term rental check-ins',
    'Saturday pickups',
  ],
  placeNames: [
    'Main yard',
    'Service bay',
    'Customer site',
    'Wash bay',
    'Counter',
  ],
  placeTypes: ['Yard', 'Bay', 'Site', 'Counter'],
  locations: [
    { code: 'YARD', name: 'Main yard', kind: 'yard' },
    { code: 'SHOP', name: 'Service bay', kind: 'warehouse' },
  ],
  weights: {
    'Lease.status': { accepted: 4, completed: 4, sent: 1, draft: 1 },
    'Estimate.status': { sent: 3, accepted: 3, declined: 1, draft: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
    'Customer.customerType': { retail: 3, wholesale: 5 },
  },
};

const NONPROFIT: SamplePack = {
  id: 'nonprofit',
  taxRate: 0,
  products: [
    {
      name: 'Annual membership',
      price: 4500,
      category: 'Membership',
      productType: 'product',
      description: 'One year, one adult, voting rights.',
      at: 0,
    },
    {
      name: 'Family membership',
      price: 7500,
      category: 'Membership',
      productType: 'product',
      description: 'Two adults and children at one address.',
      at: 0,
    },
    {
      name: 'Student membership',
      price: 2000,
      category: 'Membership',
      productType: 'product',
      description: 'Full-time students with a valid card.',
      at: 0,
    },
    {
      name: 'Gala ticket',
      price: 8500,
      category: 'Events',
      productType: 'product',
      description: 'Dinner, speaker and the silent auction.',
      at: 0,
    },
    {
      name: 'Raffle ticket',
      price: 500,
      category: 'Events',
      productType: 'product',
      description: 'Drawn at the end of the gala.',
      at: 0,
    },
    {
      name: 'Club t-shirt',
      price: 2200,
      category: 'Merchandise',
      productType: 'product',
      description: 'Cotton, club logo on the front.',
      at: 0,
    },
    {
      name: 'General-fund donation',
      price: 5000,
      category: 'Donations',
      productType: 'product',
      description: 'Unrestricted gift; receipt issued.',
      at: 0,
    },
    {
      name: 'Bronze sponsorship',
      price: 25000,
      category: 'Sponsorship',
      productType: 'product',
      description: 'Logo on the newsletter for a year.',
      at: 0,
    },
  ],
  lines: [
    { description: 'Annual dues', price: 4500, quantity: [1, 1] },
    { description: 'Family dues', price: 7500, quantity: [1, 1] },
    { description: 'Student dues', price: 2000, quantity: [1, 1] },
    { description: 'Donation', price: 5000, quantity: [1, 1] },
    { description: 'Gala ticket', price: 8500, quantity: [1, 4] },
    { description: 'Sponsorship', price: 25000, quantity: [1, 1] },
    { description: 'Workshop fee', price: 1500, quantity: [1, 1] },
    { description: 'Memorial gift', price: 10000, quantity: [1, 1] },
  ],
  customers: [
    'Margaret Hollis',
    'Devon Achebe',
    'Ruth Kowalski',
    'Sam Delacroix',
    'Nora Lindqvist',
    'Victor Osei',
    'Jean Macpherson',
    'Harbourview Hardware',
  ],
  vendors: [
    'Elm Street Hall Rentals',
    'Quick Copy Printing',
    'Maple Lane Catering',
    'Shieldstone Insurance',
    'Brightpath Web Hosting',
  ],
  instructors: ['Alice Fenwick', 'Raj Bhattacharya', 'Carol Nguyen'],
  notes: [
    'Renewal reminder sent in March.',
    'Gift aid declaration on file.',
    'Given in memory of a founding member.',
    'Paid in cash at the AGM.',
    'Receipt mailed with the newsletter.',
  ],
  terms: ['Due on receipt', 'Net 30', 'Renews each January'],
  customerNotes: [
    'Member since 2009; prefers the paper newsletter.',
    'Volunteers at every clean-up; bring extra gloves.',
    'Pays dues by cheque at the AGM.',
    'Asked not to be listed as a donor.',
    'Sponsor contact is the shop manager.',
  ],
  vendorNotes: [
    'Hall must be booked six weeks ahead.',
    'Charity discount on runs over 500.',
    'Confirm numbers the Monday before.',
    'Policy renews in October; get three quotes.',
    'Invoices the treasurer by email each year.',
  ],
  lineQuantity: [1, 1],
  descriptions: {
    Event: [
      'Annual report, elections and the budget vote.',
      'A morning of hands-on help on the grounds.',
      'Raffle, bake table and a plant sale.',
      'Open evening for members and anyone curious.',
      'Litter pick along the river path, gloves provided.',
      'Annual report, elections and the budget vote.',
      'A morning of hands-on help on the grounds.',
      'Raffle, bake table and a plant sale.',
    ],
    EventType: [
      'A formal meeting with minutes.',
      'A day of volunteer work.',
      'An event that raises money for the fund.',
      'An informal gathering for members.',
      'Picking up litter and clearing paths.',
      'The board, in private session.',
      'A teaching session on a skill.',
      'Food and company, no agenda.',
    ],
    EventSeries: [
      'First Tuesday of the month, all welcome.',
      'The board meets every other month.',
      'Four clean-ups a year, one a season.',
      'Our biggest fundraiser, every autumn.',
      'Second Saturday work parties.',
    ],
    Place: [
      'Rented hall with a kitchen and chairs for 120.',
      'Small room at the back of the hall.',
      'Park along the river, meet at the footbridge.',
      'Free meeting room, book through the front desk.',
      'A member hosts; address in the newsletter.',
    ],
  },
  eventNames: [
    'Annual general meeting',
    'Volunteer Saturday',
    'Spring fundraiser',
    'Monthly meetup',
    'River clean-up',
    'Annual general meeting',
    'Volunteer Saturday',
    'Spring fundraiser',
  ],
  eventTypes: [
    'Meeting',
    'Volunteer day',
    'Fundraiser',
    'Meetup',
    'Clean-up',
    'Board meeting',
    'Workshop',
    'Social',
  ],
  seriesNames: [
    'Monthly meetup',
    'Board meetings',
    'Quarterly clean-ups',
    'Annual gala',
    'Volunteer Saturdays',
  ],
  placeNames: [
    'Community hall',
    'Meeting room',
    'Riverside park',
    'Public library',
    "Member's garden",
  ],
  placeTypes: ['Hall', 'Room', 'Park', 'Library'],
  locations: [
    { code: 'HALL', name: 'Community hall storage', kind: 'warehouse' },
    { code: 'DESK', name: 'Welcome desk', kind: 'store' },
  ],
  weights: {
    'Agreement.status': { accepted: 6, sent: 1, completed: 2, cancelled: 1 },
    'Event.status': { scheduled: 5, completed: 4, cancelled: 1 },
    'Payment.method': { check: 3, credit_card: 4, bank_transfer: 2, cash: 1 },
    'Invoice.status': { paid: 5, sent: 2, overdue: 1, draft: 1 },
    'Customer.customerType': { retail: 1 },
  },
};

/** The packs that ship with cookbooks, by cookbook id. */
export const COOKBOOK_PACKS: Readonly<Record<string, SamplePack>> = {
  [BAKERY.id]: BAKERY,
  [MECHANIC.id]: MECHANIC,
  [WELDER.id]: WELDER,
  [YOGA.id]: YOGA,
  [LANDSCAPING.id]: LANDSCAPING,
  [SALON.id]: SALON,
  [ROASTER.id]: ROASTER,
  [EQUIPMENT_RENTAL.id]: EQUIPMENT_RENTAL,
  [NONPROFIT.id]: NONPROFIT,
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
