// utils/deliveryFee.js
const pool = require('../db/pool');

/**
 * Calculate delivery fee based on total travel minutes.
 * Queries the delivery_fee_config table.
 */
const calculateFee = async (totalMinutes) => {
  const { rows } = await pool.query(
    `SELECT * FROM delivery_fee_config
     WHERE minute_min <= $1 AND minute_max >= $1
     ORDER BY minute_min LIMIT 1`,
    [totalMinutes]
  );

  if (rows.length === 0) {
    // Fallback: long distance beyond 30 min (shouldn't happen, but handle gracefully)
    const longConfig = await pool.query(
      "SELECT * FROM delivery_fee_config WHERE distance_type = 'long'"
    );
    if (longConfig.rows.length > 0) {
      const cfg = longConfig.rows[0];
      return cfg.base_fee + (totalMinutes * cfg.rate_per_minute);
    }
    throw new Error('No delivery fee configuration found');
  }

  const config = rows[0];
  return config.base_fee + (totalMinutes * config.rate_per_minute);
};

/**
 * Estimate travel time (minutes) between two coordinate pairs.
 * PLACEHOLDER: Uses straight-line distance and a fixed average speed.
 * Replace with OSRM / Google Maps API call later.
 */
const estimateTravelTime = async (originCoords, destCoords) => {
  if (!originCoords || !destCoords) {
    // If coordinates are missing, assume a default time (e.g., 15 min)
    return 15;
  }

  // Convert coordinates from POINT(x,y) or {lat,lng} to numbers
  let lat1, lng1, lat2, lng2;
  if (typeof originCoords === 'string' && originCoords.startsWith('(')) {
    const parts = originCoords.replace(/[()]/g, '').split(',');
    lat1 = parseFloat(parts[1]);
    lng1 = parseFloat(parts[0]);
  } else if (originCoords.lat !== undefined) {
    lat1 = originCoords.lat;
    lng1 = originCoords.lng;
  }
  // same for destCoords
  if (typeof destCoords === 'string' && destCoords.startsWith('(')) {
    const parts = destCoords.replace(/[()]/g, '').split(',');
    lat2 = parseFloat(parts[1]);
    lng2 = parseFloat(parts[0]);
  } else if (destCoords.lat !== undefined) {
    lat2 = destCoords.lat;
    lng2 = destCoords.lng;
  }

  if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) {
    return 15; // default
  }

  // Haversine distance in km
  const R = 6371; // Earth radius
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distanceKm = R * c;

  // Average motorbike speed in city: 20 km/h → 3 minutes per km
  const speedKmPerHour = 20;
  const minutes = (distanceKm / speedKmPerHour) * 60;
  
  // Round up, minimum 1 minute
  return Math.ceil(minutes) || 1;
};

module.exports = { calculateFee, estimateTravelTime };
