/** Real Homescapes game icons (webp) shipped in /public. */

export const GI = {
  coins: "/gi/Coins.webp",
  stars: "/gi/Stars.webp",
  lives: "/gi/Unlimited_Lives.webp",
  level: "/gi/Gold_Medal.webp",
  cups: "/gi/Gold_Cups.webp",
  hammer: "/gi/Hammer.webp",
  glove: "/gi/Glove.webp",
  broom: "/gi/Broom.webp",
  fan: "/gi/Fan.webp",
  kettlebell: "/gi/Kettlebell.webp",
  rocketBomb: "/gi/RocketBomb.webp",
  rocketBombX: "/gi/RocketBombComplex.webp",
  sledge: "/gi/Sledgehammer.webp",
  planes: "/gi/Unlimited_Double_Planes.webp",
  superRainbow: "/gi/Super_Rainbow_Ball.webp",
  unlimitedRainbow: "/gi/Unlimited_Rainbow_Ball.webp",
  unlimitedRB: "/gi/Unlimited_Rocket_and_Bomb.webp",
  moves3: "/gi/3_Moves.webp",
  rainbow: "/gi/Rainbow_Ball.webp",
  bomb: "/gi/Bomb.webp",
  rocket: "/gi/Rocket.webp",
  plane: "/gi/Paper_Plane.webp",
  chest: "/gi/Chest.webp",
  mysteryChest: "/gi/Mystery_Chest.webp",
  ticket: "/gi/ev/Ticket.webp",
  tickets: "/gi/ev/Tickets.webp",
  goldenTicket: "/gi/ev/Golden_Ticket_Icon.webp",
  seasonPoints: "/gi/ev/Season_Points.webp",
  points: "/gi/ev/Points.webp",
  energy: "/gi/ev/Expedition_Energy.webp",
} as const;

/** Character portrait by save character id (best-effort; null when absent). */
export const CHARS: Record<string, string> = {
  Austin: "Austin", Ostin: "Austin", CatOstin: "Austin",
  Adam: "Adam", Andy: "Andy", Andy3d: "Andy",
  Arthur: "Arthur", Chloe: "Chloe", Rachel: "Rachel", Scotty: "Scotty",
  Molly: "Molly", Molly1_Farm2: "Molly", Molly2_Farm2: "Molly", Molly3_Farm2: "Molly",
  Tim: "Tim", Tom: "Tom", Jeb: "Jeb", Katherine: "Katherine", Catherine3d: "Katherine",
  Labrador: "Labrador", Claire: "Claire", Lao: "Lao",
  Charles_Barrow: "Charles_Barrow", Edward: "Charles_Barrow",
};
export const chIcon = (id: string): string | null => {
  const file = CHARS[id];
  return file ? `/gi/ch/${file}.webp` : null;
};

/** Profile-picture gallery file names (uploaded pack, sorted). */
export const PP_NAMES: string[] = ["PP_Andy_Clock_Tower_Studio","PP_Andy_Tanner","PP_Austin_Boathouse","PP_Austin_Fairy_Tale","PP_Austin_Holiday_Workshop","PP_Austin_Loving_Paris","PP_Austin_Nursery","PP_Austin_Olivia's_Bedroom","PP_Austin_Talent_Show","PP_Bakery","PP_Bakery_Event","PP_Bambino_Monkey_Spooky_Story","PP_Bunny_Rabbit_Easter_Egg_Hunt","PP_Captain_Flint","PP_Carl","PP_Cat","PP_Cat_Adventure_Marathon","PP_Cat_House_Renovation_November_2021","PP_Cat_Ocean_Mysteries","PP_Cat_Once_upon_a_Halloween","PP_Cat_Rock_Star_Crib","PP_Cat_Wedding_Anniversary","PP_Cat_Wild_West","PP_Chamber_of_Wonders","PP_Charles_Barrow's_Adventure","PP_Charles_Barrow_Living_Room","PP_Charles_Barrows_Adventure","PP_Chloe_Camp_Site","PP_Corgi_First_Season_of_Wonders","PP_Dance_Season","PP_Dock_House","PP_Dorothy_Doggylane","PP_Dragon_Lunar_New_Year_2020","PP_Ellen_Watermaine","PP_Farm","PP_Garage_Renovated","PP_Ghost_Spooky_Halloween","PP_Gingerbread_Candy_Day","PP_Goldfish_Main_Hall","PP_Gym","PP_Icy_Season_Austin","PP_Indian_Cuisine","PP_Jeb_Dodger","PP_Jerry_Wonders_of_the_World","PP_Katherine_Broom","PP_Katherine_Flower_Shop","PP_Katherine_Garden","PP_Katherine_Guest_Wing","PP_Kitty_Furry_Tales","PP_Lao","PP_Left_Wing","PP_Library","PP_Lighthouse","PP_Lisa","PP_Living_Room_Renovated","PP_Melinda","PP_Melinda_Lake_House","PP_Olivia","PP_Olivia_Adventure_Marathon","PP_Olivia_Kitchen","PP_Olivia_Magical_Holidays","PP_Olivia_Movie_Night","PP_Olivia_Retro_Party","PP_Olivia_Romantic_Terrace","PP_Party_Room_Renovated","PP_Patrick_O'Leary","PP_Penguin_Christmas","PP_Rabbit_Cottontail_Season","PP_Ralph_Ray","PP_Raul_Garage","PP_Robbie","PP_Robot_Party_Room","PP_Rock_House_TV_Station","PP_Sandra_Tropical_Paradise","PP_Scotty","PP_Shanti_Relaxation_Room","PP_Spooky_Season","PP_Stan","PP_Stephanie_Broom","PP_Stephanie_Mineral_Spring","PP_Studio","PP_Summer_Stage_Olivia","PP_Throne_Hall","PP_Toby","PP_Tom","PP_Tom_Lake_Cabin_room_1","PP_Turkey_Thanksgiving","PP_Venice_Carnival_Robbie","PP_William","PP_William's_Birthday","PP_William_Adventure_Marathon","PP_William_Cottage_in_the_Woods","PP_William_Country_Fair","PP_William_William's_Study","PP_tba","Profile_Pic_1","Profile_Pic_10","Profile_Pic_2","Profile_Pic_20","Profile_Pic_23","Profile_Pic_24","Profile_Pic_26","Profile_Pic_28","Profile_Pic_9","Profile_Picture_Cave_House_September_2021","Profile_Picture_Creepy_Season_animated_November_2021","Profile_Picture_Dance_Season_animated_August_2021","Profile_Picture_Farm_Season_animated_February_2021","Profile_Picture_Holiday_Season_animated_December_2021","Profile_Picture_Investigation_in_the_West_Express_March_2022","Profile_Picture_Observatory_February_2022","Profile_Picture_Royal_Tearoom_December_2021","Profile_Picture_Season's_Greetings_December_2021","Profile_Picture_Spooky_Halloween_October_2021","Profile_Picture_Swan_Season_March_2022","Profile_Picture_Technological_Season_animated_January_2022","Profile_Picture_The_Greatest_Show_March_2022","Profile_Picture_The_Spy_and_the_Butler_January_2022"];
export const AVATAR_PICS: Record<number, string> = {"13":"PP_Bambino_Monkey_Spooky_Story","14":"PP_Ghost_Spooky_Halloween","15":"PP_Penguin_Christmas","16":"PP_Bunny_Rabbit_Easter_Egg_Hunt","17":"PP_Gingerbread_Candy_Day","22":"PP_Olivia_Retro_Party","23":"PP_Charles_Barrow's_Adventure","24":"PP_Austin_Olivia's_Bedroom","26":"PP_Olivia_Romantic_Terrace","27":"PP_Sandra_Tropical_Paradise","28":"PP_Goldfish_Main_Hall","30":"PP_Cat_Wedding_Anniversary","31":"PP_Olivia_Kitchen","32":"PP_Katherine_Garden","33":"PP_Charles_Barrow_Living_Room","34":"PP_Raul_Garage","35":"PP_Robot_Party_Room","36":"PP_Library","37":"PP_Austin_Talent_Show","38":"PP_Turkey_Thanksgiving","39":"PP_Cat_Rock_Star_Crib","40":"PP_Andy_Clock_Tower_Studio","42":"PP_Austin_Loving_Paris","43":"PP_Jerry_Wonders_of_the_World","44":"PP_Melinda_Lake_House","45":"PP_Olivia_Magical_Holidays","46":"PP_Austin_Holiday_Workshop","47":"PP_Cat_Once_upon_a_Halloween","49":"PP_William_Cottage_in_the_Woods","50":"PP_Austin_Fairy_Tale","51":"PP_Cat_Ocean_Mysteries","52":"PP_Bakery_Event","53":"PP_William_Country_Fair","54":"PP_Olivia_Movie_Night","55":"PP_Cat_Wild_West","56":"PP_William_William's_Study","57":"PP_Austin_Nursery","58":"PP_Summer_Stage_Olivia","59":"PP_Spooky_Season","60":"PP_Icy_Season_Austin","61":"PP_Dragon_Lunar_New_Year_2020","62":"PP_Dance_Season","63":"PP_Venice_Carnival_Robbie","64":"PP_Katherine_Flower_Shop","65":"PP_Olivia_Adventure_Marathon","66":"PP_Indian_Cuisine","67":"PP_William's_Birthday","68":"PP_Andy_Tanner","69":"PP_Carl","70":"PP_Cat","71":"PP_Toby","72":"PP_Dorothy_Doggylane","73":"PP_Ellen_Watermaine","74":"PP_Katherine_Broom","75":"PP_Lao","76":"PP_Jeb_Dodger","77":"PP_Captain_Flint","78":"PP_Lisa","79":"PP_Olivia","80":"PP_William","81":"PP_Patrick_O'Leary","82":"PP_Ralph_Ray","83":"PP_Scotty","84":"PP_Stan","85":"PP_Kitty_Furry_Tales","86":"PP_Stephanie_Broom","87":"PP_Robbie","88":"PP_Corgi_First_Season_of_Wonders","89":"PP_Rabbit_Cottontail_Season","90":"PP_Studio","91":"PP_Chloe_Camp_Site","92":"PP_Tom_Lake_Cabin_room_1","93":"PP_Austin_Boathouse","94":"PP_Shanti_Relaxation_Room","95":"PP_Katherine_Guest_Wing","96":"PP_Bakery","97":"PP_Dock_House","98":"PP_Chamber_of_Wonders","99":"PP_Lighthouse","100":"PP_Farm","101":"PP_Rock_House_TV_Station","103":"PP_Gym","104":"PP_Throne_Hall","105":"PP_Left_Wing","106":"PP_tba","108":"PP_Stephanie_Mineral_Spring","109":"PP_Cat_House_Renovation_November_2021","110":"PP_Cat_Adventure_Marathon","111":"PP_William_Adventure_Marathon","113":"PP_Living_Room_Renovated","114":"PP_Garage_Renovated","115":"PP_Party_Room_Renovated"};
export const ppUrl: (name: string) => string = (name) =>
  `/pp/${name}.${/^Profile_Pic_\d+$/i.test(name) ? "png" : "webp"}`;

/* Real avatar-slot pictures for the numbered early slots (wiki: Profile_Pic_N). */
const PROFILE_NUM: Record<number, string> = {
  1: "Profile_Pic_1", 2: "Profile_Pic_2", 9: "Profile_Pic_9", 10: "Profile_Pic_10",
  20: "Profile_Pic_20", 23: "Profile_Pic_23", 24: "Profile_Pic_24", 26: "Profile_Pic_26",
  28: "Profile_Pic_28",
};
for (const [n, f] of Object.entries(PROFILE_NUM)) AVATAR_PICS[Number(n)] = f;

/* ------------------------------------------------------------------ tabs -- */
/** Original game art for the sidebar/tab pills (tool tabs keep emoji). */
export const TAB = {
  data: "/gi/Coins.webp",
  boosters: "/gi/Hammer.webp",
  lives: "/gi/Unlimited_Lives.webp",
  cosmetics: "/gi/ui/Badge-picture-0.png",
  avatars: "/pp/PP_Austin_Nursery.webp",
  quests: "/gi/ui/Start_New_Day.png",
  rooms: "/gi/ui/Mansion_Rooms.png",
  currencies: "/gi/Coins.webp",
  items: "/gi/Chest.webp",
  costumes: "/gi/ui/Suitcase_and_Hats.png",
  collections: "/gi/ui/Characters_MainPage.png",
  events: "/gi/ui/Events_MainPage.png",
  match3: "/gi/ui/Match-3_MainPage.png",
} as const;

/* ---------------------------------------------------------------- buttons -- */
/** Original game art for action buttons and feature tiles. */
export const BTN = {
  unlockAll: "/gi/ui/Homescapes_1_Unlock.png",
  unlockArea: "/gi/ui/Unlock_New_Area.png",
  newDay: "/gi/ui/Start_New_Day.png",
  reward: "/gi/ui/Reward.png",
  boxBlue: "/gi/ui/Reward_Box_Blue-Red.png",
  boxGreen: "/gi/ui/Reward_Box_Green-Orange.png",
  boxOrange: "/gi/ui/Reward_Box_Orange-Purple.png",
  boxYellow: "/gi/ui/Reward_Box_Yellow-Blue.png",
  surprise: "/gi/ui/Surprise_Boxes.png",
  keyChest: "/gi/ui/Chest_with_Keys.png",
  purpleChest: "/gi/ui/Purple_Reward_Chest.png",
  seasonChest: "/gi/ui/Season_of_Wonders_Chest.png",
  threeChests: "/gi/ui/Three_Chests_Event.png",
  moveToken: "/gi/ui/Move_Token.png",
  movesLimit: "/gi/ui/Moves_limit.png",
  moveCounter: "/gi/ui/MoveCounter.png",
  goldenTicket: "/gi/Golden_Ticket_Icon.webp",
  gems: "/gi/ui/Expedition_Gems.png",
  energy: "/gi/ui/Expedition_Energy_Bonus.png",
  bigWin: "/gi/ui/Big_Win_Icon.png",
  cascade: "/gi/ui/Cascade_Events_Icon.png",
  perk: "/gi/ui/Booster_Generator_Perk.png",
  task: "/gi/ui/Season_of_Wonders_Task.png",
  cards: "/gi/ui/Cards.png",
  cards2: "/gi/ui/Cards2.png",
  lives: "/gi/Unlimited_Lives.webp",
  livesPlayrix: "/gi/ui/Lives_Playrix.png",
} as const;

/* ----------------------------------------------------------- event art -- */
/** Event-name keyword → original event header art. */
export const EVENT_PICS: Array<[string, string]> = [
  ["spooky", "/gi/ev/Spooky_Halloween_2021.png"],
  ["horrornight", "/gi/ev/Horrornight.png"],
  ["dance", "/gi/ev/Dance_Season-_Outfits.png"],
  ["pirate", "/gi/ev/Pirate_Season-_Ship.png"],
  ["swan", "/gi/ev/Swan_Season.png"],
  ["tech", "/gi/ev/Robot_Ellie_Tech_Season.png"],
  ["woolly", "/gi/ev/Woolly_Season.png"],
  ["wooly", "/gi/ev/Woolly_Season.png"],
  ["scary", "/gi/ev/Scary_Season.png"],
  ["cottontail", "/gi/ev/Cottontail_Season_Playrix.png"],
  ["tail", "/gi/ev/Tail_Wagging_Season_Header.png"],
  ["charles", "/gi/ev/Charles_Barrow's_Adventure.png"],
  ["barrow", "/gi/ev/Charles_Barrow's_Adventure.png"],
  ["flint", "/gi/ev/Flint's_Adventures.png"],
  ["shooting", "/gi/ev/Shooting_Stars_Header.png"],
  ["icy", "/gi/ev/Icy_Season_Holiday_Decoration_November_2020.png"],
  ["pilgrim", "/gi/ev/Pilgrim_Turkey.png"],
  ["turkey", "/gi/ev/Pilgrim_Turkey.png"],
  ["bunny", "/gi/ev/Bunny_House.png"],
  ["christmas", "/gi/ev/Christmas_Tree.png"],
  ["chamber", "/gi/ev/Chamber_of_Wonders_Playrix.png"],
  ["venice", "/gi/ev/Venice_Carnival_Header.png"],
  ["retro", "/gi/ev/Retro_Party.png"],
  ["tropical", "/gi/ev/Tropical_Paradise.png"],
  ["furry", "/gi/ev/Furry_Taless.png"],
  ["marathon", "/gi/ev/Marathon_Adventure.png"],
  ["boosterville", "/gi/ev/Boosterville_Station_Header.png"],
  ["mega", "/gi/ev/Mega_Prize-_CT_Season.png"],
  ["lunar", "/gi/ev/Lunar_New_Year_Info_Box.png"],
  ["indian", "/gi/ev/Indian_Cuisine_decor.png"],
  ["cuisine", "/gi/ev/Indian_Cuisine_decor.png"],
  ["turbo", "/gi/ev/Turbo_Cat_3000-_Prize_Race.png"],
  ["knight", "/gi/ev/Knight's_Race_Guide.png"],
  ["above", "/gi/ev/Above_The_Clouds_Icon.png"],
  ["clouds", "/gi/ev/Above_The_Clouds_Icon.png"],
  ["candy", "/gi/ev/Candy_Event.png"],
  ["lantern", "/gi/ev/Lantern_Event.png"],
  ["thanksgiving", "/gi/ev/Thanksgiving_Event.png"],
  ["ocean", "/gi/ev/Ocean_of_Rewards.png"],
];
export const eventPic = (name: string): string | undefined => {
  const n = name.toLowerCase();
  for (const [kw, url] of EVENT_PICS) if (n.includes(kw)) return url;
  return undefined;
};

/* ----------------------------------------------------------- room art -- */
/** Extra room-name keyword → original room art (beyond the base-wing set). */
export const ROOM_EXTRAS: Array<[string, string]> = [
  ["dock", "/gi/rm/Dock_House.png"],
  ["lake", "/gi/rm/Lake_House.png"],
  ["throne", "/gi/rm/ThroneRoom.png"],
  ["witch", "/gi/rm/WitchHouse.png"],
  ["smart", "/gi/rm/SmartHouse.png"],
  ["printing", "/gi/rm/PrintingHouse.png"],
  ["bedroom", "/gi/rm/Bedroom.png"],
  ["boathouse", "/gi/rm/Boathouse.png"],
];
