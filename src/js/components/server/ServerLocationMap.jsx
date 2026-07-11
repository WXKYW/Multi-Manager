import React, { useMemo } from 'react';
import { BubbleMap } from '@cloudflare/kumo';
import { feature } from 'topojson-client';
import worldCountries from 'world-atlas/countries-110m.json';

const rawWorldGeoJson = feature(worldCountries, worldCountries.objects.countries);
const WORLD_GEO_JSON = {
  ...rawWorldGeoJson,
  features: rawWorldGeoJson.features
    .filter((f) => f.properties?.name !== 'Antarctica')
    .map((f) => {
      if (f.properties?.name === 'Russia' || f.properties?.name === 'Fiji') {
        const cleanCoords = (coords) => {
          if (typeof coords[0] === 'number') {
            const lon = coords[0] < 0 ? 180 : coords[0];
            const lat = coords[1];
            return [lon, lat];
          }
          return coords.map(cleanCoords);
        };
        return {
          ...f,
          geometry: {
            ...f.geometry,
            coordinates: cleanCoords(f.geometry.coordinates),
          },
        };
      }
      return f;
    }),
};

const STATUS_COLORS = {
  online: '#00A63E',
  offline: '#878787',
  interrupted: '#FC574A',
  degraded: '#F8A054',
  warning: '#F8A054',
};

const COUNTRY_CENTERS = {
  au: [-25.27, 133.77],
  ca: [56.13, -106.35],
  cn: [35.86, 104.2],
  de: [51.17, 10.45],
  fr: [46.23, 2.21],
  gb: [55.38, -3.44],
  hk: [22.32, 114.17],
  jp: [36.2, 138.25],
  kr: [35.91, 127.77],
  nl: [52.13, 5.29],
  sg: [1.35, 103.82],
  tw: [23.7, 120.96],
  us: [37.09, -95.71],
};

const COUNTRY_KEYWORDS = {
  au: ['australia', '澳大利亚'],
  ca: ['canada', '加拿大'],
  cn: ['china', '中国'],
  de: ['germany', 'frankfurt', '德国'],
  fr: ['france', 'paris', '法国'],
  gb: ['united kingdom', 'uk', 'london', '英国'],
  hk: ['hong kong', '香港'],
  jp: ['japan', 'tokyo', '日本'],
  kr: ['korea', '韩国'],
  nl: ['netherlands', 'holland', 'amsterdam', '荷兰'],
  sg: ['singapore', '新加坡'],
  tw: ['taiwan', '台湾'],
  us: ['united states', 'usa', 'america', '美国'],
};

const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const firstNumber = (...values) => {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null) return number;
  }
  return null;
};

const inferCountryCode = (server) => {
  const info = server?.info || {};
  const values = [
    server?.countryCode,
    server?.country_code,
    server?.country,
    server?.resolved_country,
    server?.location,
    server?.region,
    info.country_code,
    info.country,
    info.resolved_country,
    info.location,
    info.region,
  ].map(value => String(value || '').trim()).filter(Boolean);
  const direct = values.find(value => /^[a-z]{2}$/i.test(value));
  if (direct) return direct.toLowerCase();
  const text = values.join(' ').toLowerCase();
  return Object.entries(COUNTRY_KEYWORDS).find(([, keywords]) => keywords.some(keyword => text.includes(keyword)))?.[0] || '';
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const getServerCoordinates = (server) => {
  const info = server?.info || {};
  const system = info.system || {};
  const lat = firstNumber(server?.latitude, server?.lat, info.latitude, info.lat, system.latitude, system.lat);
  const lon = firstNumber(server?.longitude, server?.lon, info.longitude, info.lon, system.longitude, system.lon);
  if (lat !== null && lon !== null) {
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) return { lat: lon, lon: lat };
    return { lat, lon };
  }
  const countryCode = inferCountryCode(server);
  const countryCenter = COUNTRY_CENTERS[countryCode];
  return countryCenter ? { lat: countryCenter[0], lon: countryCenter[1] } : null;
};

function ServerLocationMap({
  echarts,
  servers,
  resolveStatus,
  title = '主机地图',
  subtitle = '按经纬度展示已定位主机',
  height = 190,
}) {
  const points = useMemo(() => {
    const rawPoints = (Array.isArray(servers) ? servers : [])
      .map((server) => {
        const coordinates = getServerCoordinates(server);
        if (!coordinates) return null;
        const status = resolveStatus ? resolveStatus(server) : (server?.online ? 'online' : 'offline');
        return {
          id: server?.id,
          name: server?.name || server?.host || server?.id || '主机',
          host: server?.host || '',
          status,
          value: 1,
          ...coordinates,
        };
      })
      .filter(Boolean);

    // Group by coordinates to identify overlapping points
    const groups = {};
    rawPoints.forEach((point) => {
      const key = `${point.lat.toFixed(4)}_${point.lon.toFixed(4)}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(point);
    });

    const result = [];
    Object.values(groups).forEach((group) => {
      if (group.length === 1) {
        result.push(group[0]);
      } else {
        // Spreading overlapping points in a small circle around the center coordinate
        const radius = 0.35;
        group.forEach((point, idx) => {
          const angle = (idx * 2 * Math.PI) / group.length;
          result.push({
            ...point,
            lat: point.lat + radius * Math.sin(angle),
            lon: point.lon + radius * Math.cos(angle),
          });
        });
      }
    });

    return result;
  }, [servers, resolveStatus]);

  return (
    <section className="overflow-hidden rounded-md border border-kumo-line bg-kumo-base">
      <div className="flex items-center justify-between gap-3 border-b border-kumo-line px-3 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-kumo-strong">{title}</div>
          <div className="truncate text-[10px] text-kumo-subtle">{subtitle} · {points.length}/{Array.isArray(servers) ? servers.length : 0}</div>
        </div>
      </div>
      <div className="bg-kumo-recessed/20 px-2 py-1.5">
        <BubbleMap
          echarts={echarts}
          geoJson={WORLD_GEO_JSON}
          mapName="api-monitor-world-hosts"
          data={points}
          lng="lon"
          lat="lat"
          name="name"
          value="value"
          minRadius={5}
          maxRadius={8}
          bubbleColor={(row) => STATUS_COLORS[row.status] || '#4290F0'}
          bubbleBorderColor="#ffffff"
          bubbleBorderWidth={1}
          height={height}
          zoom={1.15}
          tooltipFormatter={(row) => {
            const host = row.host ? `<span style="color:var(--text-color-kumo-subtle)">${escapeHtml(row.host)}</span>` : '';
            return `<div style="display:flex;flex-direction:column;gap:2px;"><strong>${escapeHtml(row.name)}</strong>${host}</div>`;
          }}
        />
      </div>
    </section>
  );
}

export default React.memo(ServerLocationMap);
