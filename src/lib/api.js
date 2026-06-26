export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed: ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

export function flattenDevices(reply) {
  const data = reply?.data || {};
  const fromItems = (data.items || []).map((item) => ({
    uid: item.device_uid,
    name: item.device_name || item.ps_name || item.device_uid,
    owner: item.is_owner,
    source: "items",
    raw: item,
  }));
  const fromInfos = (data.infos || []).map((info) => ({
    uid: info.device_uid,
    name: info.device_name || info.ps_name || info.device_uid,
    owner: info.is_owner,
    source: "infos",
    raw: info,
  }));

  const merged = new Map();
  for (const device of [...fromItems, ...fromInfos]) {
    if (!device.uid) continue;
    merged.set(device.uid, { ...(merged.get(device.uid) || {}), ...device });
  }
  return [...merged.values()];
}
