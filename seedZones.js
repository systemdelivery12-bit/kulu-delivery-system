// seedZones.js
require('dotenv').config();
const pool = require('./db/pool');

const zones = [
  ['Adi Haki Edaga', 'Adi Haki Edaga'],
  ['Adi Hawsi', 'Adi Hawsi'],
  ['Enda Gebriel', 'Enda Gebriel'],
  ['17 Kebele', '17 Kebele'],
  ['18 Kebele', '18 Kebele'],
  ['Ayder Laeleway Beri', 'Ayder Laeleway Beri'],
  ['Kedamay Weyane', 'Kedamay Weyane'],
  ['Adi Shumdhun', 'Adi Shumdhun'],
  ['04 Kebele', '04 Kebele'],
  ['Adi Ha', 'Adi Ha'],
  ['Arid Campus', 'Arid Campus'],
  ['Lachi Hadush Mender', 'Lachi Hadush Mender'],
  ['13 Kebele', '13 Kebele'],
  ['16 Kebele', '16 Kebele'],
  ['Adi Ha Korokonch', 'Adi Ha Korokonch'],
  ['05 Kebele', '05 Kebele'],
  ['03 Kebele', '03 Kebele'],
  ['14 Kebele', '14 Kebele'],
  ['Kelkel Debri', 'Kelkel Debri'],
  ['Mdre Genet', 'Mdre Genet'],
  ['Diaspora', 'Diaspora'],
  ['11 Kebele', '11 Kebele'],
  ['70 Kare', '70 Kare'],
  ['12 Kebele', '12 Kebele'],
  ['Jubrukh', 'Jubrukh'],
  ['Lachi Meneharya', 'Lachi Meneharya'],
  ['Ayder Tahteway Beri', 'Ayder Tahteway Beri'],
  ['Adi Haki Campus', 'Adi Haki Campus'],
  ['Debre Damo', 'Debre Damo'],
  ['15 Kebele', '15 Kebele'],
  ['Daero', 'Daero'],
  ['Dagm Amsal', 'Dagm Amsal'],
  ['Hawelti', 'Hawelti'],
  ['Haya Hulet', 'Haya Hulet']
];

const seed = async () => {
  try {
    for (const [nameTig, nameEng] of zones) {
      await pool.query(
        'INSERT INTO zones (name_tig, name_eng) VALUES ($1, $2)',
        [nameTig, nameEng]
      );
    }
    console.log('✅ All 34 zones seeded successfully!');
  } catch (err) {
    console.error('❌ Error seeding zones:', err.message);
  } finally {
    pool.end();
  }
};

seed();
