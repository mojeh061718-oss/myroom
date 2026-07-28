import { ObjectCategorySchema, type ObjectCategory, type Support } from "@myroom/schema";

/**
 * The object taxonomy — every kind of thing My Room Sandbox can put in a room.
 *
 * Three consumers share this one list:
 *  1. **Detection vocabulary** (docs/05 §3) — the open-vocabulary prompts fed to
 *     Grounding DINO in M4.
 *  2. **Parametric placeholders** (docs/05 §6) — when no CC0 model matches, the
 *     category's `defaultSize` and `support` produce a clean stand-in, so a
 *     detected object is *never silently omitted*.
 *  3. **Catalog browser** (docs/06 §5) — `group` is the category tree, and
 *     `defaultSize` drives the "fits here" filter.
 *
 * Everything here is discrete and individually editable (BLUEPRINT §2): each
 * entry can be selected, moved, restyled, swapped or deleted. Nothing in this
 * list is ever baked into the shell.
 *
 * Sizes are typical real-world dimensions in **meters** (BLUEPRINT §3), used
 * until a photo/LiDAR measurement or a catalog model supplies the real one.
 */

interface Opts {
  /** default is "floor" */
  support?: Support;
  /**
   * Meters from floor to object center, required for wall/ceiling items and
   * quoted against the default 2.44 m ceiling (docs/04 §5). Ceiling items are
   * re-anchored to the room's actual ceiling when placed.
   */
  mount?: number;
  /** default is ["body"] */
  slots?: string[];
  /** flat-front classes take a rectified photo crop as their face (docs/05 §7) */
  face?: boolean;
  /** rugs and wall items don't participate in collision (docs/06 §3) */
  exempt?: boolean;
  /** extra detection synonyms beyond the label itself */
  also?: string[];
}

/** [id, label, width, depth, height, opts] — meters. */
type Row = readonly [string, string, number, number, number, Opts?];

const GROUPS: Record<string, readonly Row[]> = {
  Seating: [
    ["sofa", "Sofa", 2.1, 0.92, 0.83, { slots: ["upholstery", "legs"], also: ["couch", "settee"] }],
    ["sectional", "Sectional", 2.6, 1.8, 0.84, { slots: ["upholstery", "legs"], also: ["l-shaped sofa", "corner sofa"] }],
    ["loveseat", "Loveseat", 1.5, 0.9, 0.83, { slots: ["upholstery", "legs"], also: ["two-seat sofa"] }],
    ["armchair", "Armchair", 0.85, 0.88, 0.8, { slots: ["upholstery", "legs"] }],
    ["accent-chair", "Accent Chair", 0.7, 0.72, 0.85, { slots: ["upholstery", "legs"] }],
    ["recliner", "Recliner", 0.9, 0.95, 1.05, { slots: ["upholstery", "base"] }],
    ["dining-chair", "Dining Chair", 0.46, 0.52, 0.9, { slots: ["seat", "frame"] }],
    ["office-chair", "Office Chair", 0.65, 0.65, 1.1, { slots: ["upholstery", "base"], also: ["desk chair", "task chair"] }],
    ["rocking-chair", "Rocking Chair", 0.65, 0.9, 1.05, { slots: ["seat", "frame"] }],
    ["folding-chair", "Folding Chair", 0.45, 0.5, 0.85, { slots: ["seat", "frame"] }],
    ["stool", "Stool", 0.36, 0.36, 0.45, { slots: ["seat", "legs"] }],
    ["bar-stool", "Bar Stool", 0.4, 0.4, 0.75, { slots: ["seat", "legs"], also: ["counter stool"] }],
    ["bench", "Bench", 1.2, 0.4, 0.45, { slots: ["seat", "legs"] }],
    ["ottoman", "Ottoman", 0.7, 0.7, 0.42, { slots: ["upholstery", "legs"], also: ["footstool", "footrest"] }],
    ["pouf", "Pouf", 0.55, 0.55, 0.4, { slots: ["upholstery"] }],
    ["chaise-lounge", "Chaise Lounge", 0.8, 1.65, 0.8, { slots: ["upholstery", "legs"] }],
    ["beanbag", "Beanbag", 0.9, 0.9, 0.7, { slots: ["upholstery"], also: ["bean bag chair"] }],
    ["floor-cushion", "Floor Cushion", 0.6, 0.6, 0.15, { slots: ["upholstery"], exempt: true }],
  ],

  "Tables & Desks": [
    ["coffee-table", "Coffee Table", 1.2, 0.6, 0.42, { slots: ["top", "legs"] }],
    ["side-table", "Side Table", 0.45, 0.45, 0.55, { slots: ["top", "legs"], also: ["end table"] }],
    ["console-table", "Console Table", 1.2, 0.35, 0.78, { slots: ["top", "legs"], also: ["hall table"] }],
    ["dining-table", "Dining Table", 1.8, 0.9, 0.75, { slots: ["top", "legs"] }],
    ["nesting-tables", "Nesting Tables", 0.55, 0.55, 0.5, { slots: ["top", "legs"] }],
    ["desk", "Desk", 1.4, 0.7, 0.75, { slots: ["top", "legs"], also: ["writing desk", "computer desk"] }],
    ["nightstand", "Nightstand", 0.45, 0.4, 0.55, { slots: ["body", "handles"], also: ["bedside table"] }],
    ["vanity-table", "Vanity Table", 1.1, 0.45, 0.78, { slots: ["top", "legs"], also: ["dressing table"] }],
    ["bar-cart", "Bar Cart", 0.75, 0.4, 0.8, { slots: ["frame", "shelves"], also: ["serving trolley"] }],
    ["folding-table", "Folding Table", 1.2, 0.6, 0.74, { slots: ["top", "legs"] }],
    ["kitchen-island", "Kitchen Island", 1.6, 0.9, 0.92, { slots: ["counter", "body"] }],
  ],

  Storage: [
    ["bookshelf", "Bookshelf", 0.8, 0.3, 1.8, { slots: ["body", "shelves"], also: ["bookcase", "shelving unit"] }],
    ["floating-shelf", "Floating Shelf", 0.9, 0.22, 0.04, { support: "wall", mount: 1.4, exempt: true, slots: ["shelf"], also: ["wall shelf", "shelf"] }],
    ["wall-shelf-unit", "Wall Shelf Unit", 0.8, 0.25, 0.7, { support: "wall", mount: 1.3, exempt: true, slots: ["body", "shelves"], also: ["hanging shelves", "shelves"] }],
    ["cabinet", "Cabinet", 0.9, 0.45, 0.85, { slots: ["body", "doors", "handles"], also: ["storage cabinet", "cupboard"] }],
    ["wall-cabinet", "Wall Cabinet", 0.8, 0.35, 0.7, { support: "wall", mount: 1.65, exempt: true, slots: ["body", "doors", "handles"], also: ["upper cabinet", "wall cupboard"] }],
    ["kitchen-base-cabinet", "Kitchen Base Cabinet", 0.6, 0.6, 0.88, { slots: ["body", "doors", "handles"], also: ["base cabinet", "kitchen cabinet"] }],
    ["pantry-cabinet", "Pantry Cabinet", 0.6, 0.6, 2.1, { slots: ["body", "doors", "handles"], also: ["tall cabinet", "larder"] }],
    ["display-cabinet", "Display Cabinet", 0.9, 0.4, 1.8, { slots: ["body", "glass"], also: ["china cabinet", "curio cabinet"] }],
    ["media-console", "Media Console", 1.6, 0.4, 0.5, { slots: ["body", "doors"], also: ["tv stand", "tv console", "entertainment center"] }],
    ["sideboard", "Sideboard", 1.6, 0.45, 0.8, { slots: ["body", "doors", "handles"], also: ["credenza"] }],
    ["buffet", "Buffet", 1.5, 0.45, 0.9, { slots: ["body", "doors", "handles"] }],
    ["dresser", "Dresser", 1.2, 0.5, 0.8, { slots: ["body", "drawers", "handles"] }],
    ["chest-of-drawers", "Chest of Drawers", 0.8, 0.45, 1.1, { slots: ["body", "drawers", "handles"], also: ["tallboy"] }],
    ["wardrobe", "Wardrobe", 1.2, 0.6, 2.0, { slots: ["body", "doors", "handles"], also: ["closet", "armoire"] }],
    ["filing-cabinet", "Filing Cabinet", 0.4, 0.6, 0.72, { slots: ["body", "drawers"] }],
    ["storage-bench", "Storage Bench", 1.1, 0.4, 0.45, { slots: ["upholstery", "body"] }],
    ["cube-storage", "Cube Storage", 0.75, 0.35, 0.75, { slots: ["body"], also: ["cubby shelf", "storage cubes"] }],
    ["shoe-rack", "Shoe Rack", 0.7, 0.3, 0.8, { slots: ["frame"] }],
    ["coat-rack", "Coat Rack", 0.5, 0.5, 1.75, { slots: ["frame"], also: ["coat stand", "hall tree", "hat stand"] }],
    ["wall-coat-hooks", "Wall Coat Hooks", 0.6, 0.08, 0.12, { support: "wall", mount: 1.6, exempt: true, slots: ["rail", "hooks"], also: ["coat hooks", "wall hooks"] }],
    ["umbrella-stand", "Umbrella Stand", 0.25, 0.25, 0.5, { slots: ["body"] }],
    ["storage-trunk", "Storage Trunk", 0.9, 0.45, 0.45, { slots: ["body"], also: ["chest"] }],
    ["toy-chest", "Toy Chest", 0.8, 0.42, 0.5, { slots: ["body"], also: ["toy box"] }],
    ["magazine-rack", "Magazine Rack", 0.35, 0.25, 0.4, { slots: ["frame"] }],
    ["storage-basket", "Storage Basket", 0.45, 0.35, 0.35, { slots: ["body"], also: ["woven basket"] }],
    ["laundry-hamper", "Laundry Hamper", 0.45, 0.35, 0.6, { slots: ["body"], also: ["laundry basket"] }],
    ["room-divider", "Room Divider", 1.8, 0.4, 1.7, { slots: ["panels", "frame"], also: ["folding screen"] }],
    ["safe", "Safe", 0.45, 0.4, 0.55, { slots: ["body"] }],
  ],

  Beds: [
    ["bed", "Double Bed", 1.6, 2.1, 0.55, { slots: ["frame", "bedding"], also: ["queen bed"] }],
    ["single-bed", "Single Bed", 1.0, 2.05, 0.55, { slots: ["frame", "bedding"], also: ["twin bed"] }],
    ["king-bed", "King Bed", 1.95, 2.1, 0.6, { slots: ["frame", "bedding"] }],
    ["bunk-bed", "Bunk Bed", 1.05, 2.05, 1.65, { slots: ["frame", "bedding"] }],
    ["daybed", "Daybed", 1.05, 2.0, 0.9, { slots: ["frame", "upholstery"] }],
    ["mattress", "Mattress", 1.5, 2.0, 0.25, { slots: ["bedding"] }],
    ["crib", "Crib", 0.75, 1.35, 1.0, { slots: ["frame", "bedding"], also: ["cot"] }],
    ["headboard", "Headboard", 1.6, 0.08, 1.1, { support: "wall", mount: 1.05, exempt: true, slots: ["upholstery", "frame"] }],
  ],

  "Kitchen Appliances": [
    ["refrigerator", "Refrigerator", 0.75, 0.7, 1.8, { slots: ["body", "handles"], also: ["fridge", "freezer fridge"] }],
    ["freezer", "Freezer", 0.6, 0.65, 1.45, { slots: ["body", "handles"], also: ["chest freezer"] }],
    ["oven", "Oven", 0.6, 0.6, 0.85, { slots: ["body", "glass"], also: ["wall oven"] }],
    ["range", "Range", 0.76, 0.66, 0.92, { slots: ["body", "glass"], also: ["stove", "cooker"] }],
    ["cooktop", "Cooktop", 0.6, 0.52, 0.05, { support: "surface", slots: ["surface"], also: ["hob", "stovetop"] }],
    ["range-hood", "Range Hood", 0.76, 0.5, 0.6, { support: "wall", mount: 1.85, exempt: true, slots: ["body"], also: ["extractor hood", "cooker hood"] }],
    ["microwave", "Microwave", 0.5, 0.38, 0.3, { support: "surface", slots: ["body", "glass"], also: ["microwave oven"] }],
    ["air-fryer", "Air Fryer", 0.32, 0.36, 0.34, { support: "surface", slots: ["body"], also: ["airfryer", "air fryer oven"] }],
    ["toaster", "Toaster", 0.28, 0.18, 0.2, { support: "surface", slots: ["body"] }],
    ["toaster-oven", "Toaster Oven", 0.45, 0.33, 0.28, { support: "surface", slots: ["body", "glass"] }],
    ["kettle", "Kettle", 0.22, 0.16, 0.25, { support: "surface", slots: ["body"], also: ["electric kettle"] }],
    ["coffee-maker", "Coffee Maker", 0.28, 0.2, 0.35, { support: "surface", slots: ["body"], also: ["coffee machine", "drip coffee maker"] }],
    ["espresso-machine", "Espresso Machine", 0.3, 0.35, 0.4, { support: "surface", slots: ["body"] }],
    ["blender", "Blender", 0.18, 0.2, 0.42, { support: "surface", slots: ["body", "jug"] }],
    ["stand-mixer", "Stand Mixer", 0.36, 0.22, 0.35, { support: "surface", slots: ["body"] }],
    ["rice-cooker", "Rice Cooker", 0.28, 0.28, 0.26, { support: "surface", slots: ["body"] }],
    ["slow-cooker", "Slow Cooker", 0.35, 0.26, 0.3, { support: "surface", slots: ["body"], also: ["instant pot", "pressure cooker"] }],
    ["dishwasher", "Dishwasher", 0.6, 0.6, 0.85, { slots: ["body", "handles"] }],
    ["kitchen-sink", "Kitchen Sink", 0.8, 0.5, 0.2, { support: "surface", slots: ["basin", "tap"], also: ["sink"] }],
    ["water-dispenser", "Water Dispenser", 0.32, 0.32, 1.1, { slots: ["body"], also: ["water cooler"] }],
    ["trash-can", "Trash Can", 0.35, 0.35, 0.65, { slots: ["body"], also: ["bin", "waste bin", "rubbish bin"] }],
    ["recycling-bin", "Recycling Bin", 0.35, 0.35, 0.65, { slots: ["body"] }],
  ],

  Laundry: [
    ["washing-machine", "Washing Machine", 0.6, 0.6, 0.85, { slots: ["body", "glass"], also: ["washer"] }],
    ["clothes-dryer", "Clothes Dryer", 0.6, 0.6, 0.85, { slots: ["body", "glass"], also: ["tumble dryer", "dryer"] }],
    ["drying-rack", "Drying Rack", 0.6, 0.55, 1.05, { slots: ["frame"], also: ["clothes airer"] }],
    ["ironing-board", "Ironing Board", 1.2, 0.38, 0.9, { slots: ["top", "legs"] }],
    ["vacuum-cleaner", "Vacuum Cleaner", 0.35, 0.4, 1.1, { slots: ["body"], also: ["vacuum", "hoover"] }],
  ],

  Electronics: [
    ["tv", "TV", 1.23, 0.07, 0.71, { support: "wall", mount: 1.15, exempt: true, face: true, slots: ["frame"], also: ["television", "flat screen tv", "wall-mounted tv"] }],
    ["monitor", "Monitor", 0.62, 0.2, 0.45, { support: "surface", face: true, slots: ["frame", "stand"], also: ["computer monitor", "display"] }],
    ["computer-tower", "Computer Tower", 0.2, 0.45, 0.45, { slots: ["body"], also: ["desktop pc", "pc tower"] }],
    ["laptop", "Laptop", 0.35, 0.25, 0.02, { support: "surface", face: true, slots: ["body"], also: ["notebook computer"] }],
    ["soundbar", "Soundbar", 1.0, 0.1, 0.07, { support: "surface", slots: ["body"] }],
    ["floor-speaker", "Floor Speaker", 0.2, 0.25, 1.0, { slots: ["body", "grille"], also: ["tower speaker", "speaker"] }],
    ["bookshelf-speaker", "Bookshelf Speaker", 0.18, 0.22, 0.3, { support: "surface", slots: ["body", "grille"] }],
    ["subwoofer", "Subwoofer", 0.35, 0.35, 0.4, { slots: ["body"] }],
    ["game-console", "Game Console", 0.3, 0.25, 0.1, { support: "surface", slots: ["body"], also: ["games console"] }],
    ["printer", "Printer", 0.45, 0.38, 0.25, { support: "surface", slots: ["body"] }],
    ["projector", "Projector", 0.32, 0.25, 0.12, { support: "surface", slots: ["body"] }],
    ["projector-screen", "Projector Screen", 1.8, 0.06, 1.3, { support: "wall", mount: 1.6, exempt: true, face: true, slots: ["screen", "frame"] }],
    ["turntable", "Turntable", 0.45, 0.35, 0.15, { support: "surface", slots: ["body"], also: ["record player"] }],
    ["stereo-receiver", "Stereo Receiver", 0.44, 0.35, 0.15, { support: "surface", slots: ["body"], also: ["amplifier", "av receiver"] }],
    ["router", "Router", 0.22, 0.16, 0.05, { support: "surface", slots: ["body"], also: ["wifi router", "modem"] }],
  ],

  "Fans & Climate": [
    ["ceiling-fan", "Ceiling Fan", 1.32, 1.32, 0.35, { support: "ceiling", mount: 2.26, slots: ["blades", "motor"], also: ["fan"] }],
    ["floor-fan", "Floor Fan", 0.45, 0.4, 1.3, { slots: ["blades", "body"], also: ["pedestal fan", "standing fan", "fan"] }],
    ["tower-fan", "Tower Fan", 0.3, 0.3, 1.05, { slots: ["body"], also: ["bladeless fan"] }],
    ["desk-fan", "Desk Fan", 0.32, 0.2, 0.4, { support: "surface", slots: ["blades", "body"], also: ["table fan"] }],
    ["exhaust-fan", "Exhaust Fan", 0.3, 0.3, 0.12, { support: "ceiling", mount: 2.38, slots: ["body"], also: ["ventilation fan"] }],
    ["air-purifier", "Air Purifier", 0.3, 0.3, 0.6, { slots: ["body"] }],
    ["humidifier", "Humidifier", 0.25, 0.25, 0.35, { support: "surface", slots: ["body"] }],
    ["dehumidifier", "Dehumidifier", 0.35, 0.28, 0.55, { slots: ["body"] }],
    ["space-heater", "Space Heater", 0.4, 0.25, 0.55, { slots: ["body"], also: ["portable heater"] }],
    ["radiator", "Radiator", 1.0, 0.1, 0.6, { support: "wall", mount: 0.45, exempt: true, slots: ["body"] }],
    ["air-conditioner", "Air Conditioner", 0.9, 0.25, 0.35, { support: "wall", mount: 2.0, exempt: true, slots: ["body"], also: ["ac unit", "split ac", "aircon"] }],
    ["thermostat", "Thermostat", 0.12, 0.03, 0.12, { support: "wall", mount: 1.5, exempt: true, slots: ["body"] }],
  ],

  Lighting: [
    ["floor-lamp", "Floor Lamp", 0.4, 0.4, 1.6, { slots: ["shade", "base"], also: ["standing lamp"] }],
    ["table-lamp", "Table Lamp", 0.32, 0.32, 0.55, { support: "surface", slots: ["shade", "base"] }],
    ["desk-lamp", "Desk Lamp", 0.2, 0.2, 0.45, { support: "surface", slots: ["shade", "base"] }],
    ["pendant-light", "Pendant Light", 0.35, 0.35, 0.45, { support: "ceiling", mount: 1.95, slots: ["shade", "cord"], also: ["pendant", "hanging light"] }],
    ["chandelier", "Chandelier", 0.7, 0.7, 0.6, { support: "ceiling", mount: 2.05, slots: ["frame", "shades"] }],
    ["ceiling-light", "Ceiling Light", 0.45, 0.45, 0.15, { support: "ceiling", mount: 2.36, slots: ["shade"], also: ["flush mount light", "ceiling lamp"] }],
    ["track-lighting", "Track Lighting", 1.2, 0.1, 0.15, { support: "ceiling", mount: 2.36, slots: ["track", "heads"] }],
    ["wall-sconce", "Wall Sconce", 0.18, 0.2, 0.3, { support: "wall", mount: 1.7, exempt: true, slots: ["shade", "base"], also: ["wall light"] }],
    ["string-lights", "String Lights", 2.0, 0.05, 0.2, { support: "wall", mount: 2.1, exempt: true, slots: ["lights"], also: ["fairy lights"] }],
    ["lantern", "Lantern", 0.2, 0.2, 0.35, { support: "surface", slots: ["frame", "glass"] }],
  ],

  "Wall Decor": [
    ["framed-picture", "Framed Picture", 0.6, 0.04, 0.8, { support: "wall", mount: 1.55, exempt: true, face: true, slots: ["frame", "mat"], also: ["framed art", "picture", "painting", "framed photo", "wall art"] }],
    ["canvas-art", "Canvas Art", 0.9, 0.05, 0.6, { support: "wall", mount: 1.55, exempt: true, face: true, slots: ["canvas"], also: ["canvas print"] }],
    ["poster", "Poster", 0.6, 0.02, 0.9, { support: "wall", mount: 1.55, exempt: true, face: true, slots: ["print"] }],
    ["gallery-wall-set", "Gallery Wall Set", 1.4, 0.04, 1.0, { support: "wall", mount: 1.55, exempt: true, face: true, slots: ["frames"], also: ["picture wall", "photo wall"] }],
    ["photo-frame", "Photo Frame", 0.2, 0.06, 0.25, { support: "surface", face: true, slots: ["frame"], also: ["picture frame", "tabletop frame"] }],
    ["mirror", "Mirror", 0.6, 0.05, 0.9, { support: "wall", mount: 1.55, exempt: true, slots: ["frame", "glass"], also: ["wall mirror"] }],
    ["floor-mirror", "Floor Mirror", 0.55, 0.1, 1.7, { slots: ["frame", "glass"], also: ["full-length mirror", "leaning mirror"] }],
    ["wall-clock", "Wall Clock", 0.35, 0.06, 0.35, { support: "wall", mount: 1.9, exempt: true, face: true, slots: ["frame", "face"], also: ["clock"] }],
    ["tapestry", "Tapestry", 1.2, 0.03, 1.5, { support: "wall", mount: 1.6, exempt: true, face: true, slots: ["fabric"], also: ["wall hanging"] }],
    ["whiteboard", "Whiteboard", 1.2, 0.04, 0.9, { support: "wall", mount: 1.5, exempt: true, face: true, slots: ["board", "frame"], also: ["dry erase board"] }],
    ["bulletin-board", "Bulletin Board", 0.9, 0.04, 0.6, { support: "wall", mount: 1.5, exempt: true, face: true, slots: ["board", "frame"], also: ["corkboard", "pin board"] }],
    ["pegboard", "Pegboard", 1.0, 0.03, 0.6, { support: "wall", mount: 1.5, exempt: true, slots: ["board"] }],
  ],

  "Soft Furnishings": [
    ["rug", "Rug", 2.4, 1.7, 0.02, { exempt: true, face: true, slots: ["pile"], also: ["area rug", "carpet"] }],
    ["runner-rug", "Runner Rug", 0.8, 2.4, 0.02, { exempt: true, face: true, slots: ["pile"], also: ["hallway runner"] }],
    ["curtain", "Curtains", 1.2, 0.12, 2.2, { support: "wall", mount: 1.2, exempt: true, slots: ["fabric", "rod"], also: ["drapes", "curtains"] }],
    ["blinds", "Blinds", 1.2, 0.08, 1.6, { support: "wall", mount: 1.55, exempt: true, slots: ["slats"], also: ["window blinds", "shades"] }],
    ["throw-pillow", "Throw Pillow", 0.45, 0.15, 0.45, { support: "surface", exempt: true, slots: ["fabric"], also: ["cushion", "pillow"] }],
    ["floor-pillow", "Floor Pillow", 0.5, 0.5, 0.12, { exempt: true, slots: ["fabric"] }],
    ["throw-blanket", "Throw Blanket", 1.4, 0.3, 0.1, { support: "surface", exempt: true, slots: ["fabric"], also: ["blanket", "throw"] }],
  ],

  "Plants & Decor": [
    ["floor-plant", "Floor Plant", 0.6, 0.6, 1.4, { slots: ["foliage", "pot"], also: ["large potted plant", "indoor tree", "plant"] }],
    ["potted-plant", "Potted Plant", 0.3, 0.3, 0.45, { support: "surface", slots: ["foliage", "pot"], also: ["houseplant", "plant"] }],
    ["hanging-plant", "Hanging Plant", 0.35, 0.35, 0.6, { support: "ceiling", mount: 1.9, slots: ["foliage", "pot"] }],
    ["vase", "Vase", 0.2, 0.2, 0.35, { support: "surface", slots: ["body"] }],
    ["sculpture", "Sculpture", 0.25, 0.25, 0.4, { support: "surface", slots: ["body"], also: ["figurine", "ornament"] }],
    ["candle", "Candle", 0.08, 0.08, 0.15, { support: "surface", slots: ["body"], also: ["candles", "candle holder"] }],
    ["books", "Books", 0.25, 0.18, 0.22, { support: "surface", slots: ["covers"], also: ["stack of books"] }],
    ["decorative-bowl", "Decorative Bowl", 0.3, 0.3, 0.1, { support: "surface", slots: ["body"], also: ["bowl"] }],
    ["tray", "Tray", 0.4, 0.28, 0.05, { support: "surface", slots: ["body"] }],
    ["aquarium", "Aquarium", 1.0, 0.4, 0.5, { support: "surface", slots: ["glass", "frame"], also: ["fish tank"] }],
  ],

  Bathroom: [
    ["toilet", "Toilet", 0.38, 0.7, 0.78, { slots: ["body", "seat"] }],
    ["bathtub", "Bathtub", 1.7, 0.75, 0.55, { slots: ["body"], also: ["bath tub"] }],
    ["shower-enclosure", "Shower", 0.9, 0.9, 2.0, { slots: ["glass", "frame"], also: ["shower cubicle"] }],
    ["bathroom-vanity", "Bathroom Vanity", 0.8, 0.48, 0.85, { slots: ["body", "basin"], also: ["washbasin cabinet"] }],
    ["towel-rack", "Towel Rack", 0.6, 0.1, 0.08, { support: "wall", mount: 1.3, exempt: true, slots: ["rail"], also: ["towel rail", "towel bar"] }],
    ["medicine-cabinet", "Medicine Cabinet", 0.6, 0.15, 0.7, { support: "wall", mount: 1.6, exempt: true, slots: ["body", "mirror"], also: ["bathroom cabinet"] }],
  ],

  Kids: [
    ["high-chair", "High Chair", 0.55, 0.6, 1.0, { slots: ["seat", "frame"] }],
    ["changing-table", "Changing Table", 0.9, 0.55, 1.0, { slots: ["body", "pad"] }],
    ["play-mat", "Play Mat", 1.5, 1.5, 0.02, { exempt: true, face: true, slots: ["surface"] }],
    ["stroller", "Stroller", 0.6, 1.0, 1.05, { slots: ["frame", "fabric"], also: ["pushchair", "pram"] }],
  ],

  Fitness: [
    ["treadmill", "Treadmill", 0.85, 1.8, 1.35, { slots: ["frame", "deck"], also: ["running machine"] }],
    ["exercise-bike", "Exercise Bike", 0.55, 1.1, 1.3, { slots: ["frame"], also: ["stationary bike", "spin bike"] }],
    ["weight-bench", "Weight Bench", 0.6, 1.2, 0.45, { slots: ["upholstery", "frame"] }],
    ["dumbbell-rack", "Dumbbell Rack", 1.0, 0.45, 0.75, { slots: ["frame", "weights"] }],
    ["yoga-mat", "Yoga Mat", 0.61, 1.73, 0.01, { exempt: true, slots: ["surface"], also: ["exercise mat"] }],
  ],

  "Hobbies & Pets": [
    ["fireplace", "Fireplace", 1.2, 0.35, 1.1, { support: "wall", mount: 0.55, exempt: true, slots: ["surround", "firebox"], also: ["mantelpiece"] }],
    ["wood-stove", "Wood Stove", 0.6, 0.55, 0.9, { slots: ["body"], also: ["log burner"] }],
    ["upright-piano", "Upright Piano", 1.5, 0.6, 1.25, { slots: ["body", "keys"], also: ["piano"] }],
    ["grand-piano", "Grand Piano", 1.5, 1.9, 1.0, { slots: ["body", "keys"] }],
    ["guitar", "Guitar", 0.4, 0.15, 1.0, { slots: ["body"], also: ["acoustic guitar", "electric guitar"] }],
    ["guitar-stand", "Guitar Stand", 0.35, 0.35, 0.6, { slots: ["frame"] }],
    ["drum-kit", "Drum Kit", 1.4, 1.2, 1.1, { slots: ["shells", "hardware"], also: ["drums"] }],
    ["easel", "Easel", 0.65, 0.6, 1.6, { slots: ["frame"] }],
    ["sewing-machine", "Sewing Machine", 0.45, 0.25, 0.35, { support: "surface", slots: ["body"] }],
    ["step-ladder", "Step Ladder", 0.5, 0.8, 1.5, { slots: ["frame"], also: ["ladder"] }],
    ["pet-bed", "Pet Bed", 0.7, 0.55, 0.18, { exempt: true, slots: ["upholstery"], also: ["dog bed", "cat bed"] }],
    ["dog-crate", "Dog Crate", 0.9, 0.6, 0.65, { slots: ["frame"], also: ["pet crate"] }],
    ["litter-box", "Litter Box", 0.5, 0.38, 0.2, { slots: ["body"], also: ["cat litter tray"] }],
    ["birdcage", "Birdcage", 0.5, 0.5, 1.4, { slots: ["frame"], also: ["bird cage"] }],
  ],
};

function build(): ObjectCategory[] {
  const out: ObjectCategory[] = [];
  for (const [group, rows] of Object.entries(GROUPS)) {
    for (const [id, label, w, d, h, opts = {}] of rows) {
      const support = opts.support ?? "floor";
      const category: ObjectCategory = {
        id,
        label,
        group,
        support,
        defaultSize: { w, d, h },
        mountHeight: opts.mount ?? null,
        materialSlots: opts.slots ?? ["body"],
        faceSlot: opts.face ? "face" : null,
        // Wall and ceiling items never block floor traffic (docs/06 §3).
        collisionExempt: opts.exempt ?? (support === "wall" || support === "ceiling"),
        detectionPrompts: [label.toLowerCase(), ...(opts.also ?? [])],
      };
      out.push(ObjectCategorySchema.parse(category));
    }
  }
  return out;
}

export const OBJECT_CATEGORIES: readonly ObjectCategory[] = Object.freeze(build());

const BY_ID = new Map(OBJECT_CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: string): ObjectCategory | undefined {
  return BY_ID.get(id);
}

export const CATEGORY_GROUPS: readonly string[] = Object.freeze(Object.keys(GROUPS));

export function categoriesInGroup(group: string): ObjectCategory[] {
  return OBJECT_CATEGORIES.filter((c) => c.group === group);
}

/**
 * The open-vocabulary detection vocabulary (docs/05 §3): every prompt across
 * every category, deduped, each mapped back to the category it resolves to.
 */
export function detectionVocabulary(): Map<string, string> {
  const vocab = new Map<string, string>();
  for (const c of OBJECT_CATEGORIES) {
    for (const prompt of c.detectionPrompts) {
      if (!vocab.has(prompt)) vocab.set(prompt, c.id);
    }
  }
  return vocab;
}
