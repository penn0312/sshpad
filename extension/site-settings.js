import { groupKey, libraryWithEdits, orderedSources, readSite } from './library.js';

const view = id => document.getElementById(id);

export function setupSites(request) {
  let libraries = {};
  let activeSite;

  function showSites(sites) {
    const fragment = document.createDocumentFragment();
    for (const site of sites) {
      const row = document.createElement('li');
      row.className = 'controls site-row';
      const origin = document.createElement('strong');
      origin.textContent = site.origin;
      const summary = document.createElement('small');
      summary.textContent = site.groups === null ? '全部分组' : `已选 ${site.groups.length} 个分组`;
      const groups = document.createElement('button');
      groups.type = 'button';
      groups.className = 'secondary';
      groups.textContent = '显示分组';
      groups.addEventListener('click', () => openGroups(site));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary danger';
      remove.textContent = '移除站点';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const result = await request({ type: 'remove-site', origin: site.origin });
          showSites(result.sites);
        } catch (error) {
          view('site-status').textContent = error.message;
          remove.disabled = false;
        }
      });
      row.append(origin, summary, groups, remove);
      fragment.append(row);
    }
    view('site-list').replaceChildren(fragment);
    view('site-status').textContent = sites.length ? '' : '尚未授权 JumpServer 站点。';
  }

  function openGroups(site) {
    activeSite = site;
    view('site-groups-origin').textContent = site.origin;
    view('site-groups-status').textContent = '';
    const all = view('show-all-groups');
    all.checked = site.groups === null;
    const list = view('site-groups-list');
    const legend = list.querySelector('legend');
    list.replaceChildren(legend);
    list.disabled = all.checked;
    for (const source of orderedSources(libraries)) {
      for (const group of libraryWithEdits(source).groups) {
        const label = document.createElement('label');
        label.className = 'checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = groupKey(source.library.sourceId, group.id);
        checkbox.checked = site.groups === null || site.groups.includes(checkbox.value);
        label.append(checkbox, ` ${group.name}`);
        list.append(label);
      }
    }
    view('site-groups-dialog').showModal();
  }

  view('site-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const site = readSite(view('origin').value);
      if (!await chrome.permissions.request({ origins: [site.permission] })) {
        view('site-status').textContent = 'Chrome 未批准此站点。';
        return;
      }
      showSites((await request({ type: 'site', origin: site.origin })).sites);
      view('origin').value = '';
      view('site-status').textContent = '站点已授权，请刷新该站点的 Luna 页面。';
    } catch (error) {
      view('site-status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  view('show-all-groups').addEventListener('change', event => {
    view('site-groups-list').disabled = event.target.checked;
  });
  view('cancel-site-groups').addEventListener('click', () => view('site-groups-dialog').close());
  view('site-groups-form').addEventListener('submit', async event => {
    event.preventDefault();
    const save = view('save-site-groups');
    save.disabled = true;
    try {
      const groups = view('show-all-groups').checked ? null :
        [...view('site-groups-list').querySelectorAll('input:checked')].map(checkbox => checkbox.value);
      const result = await request({ type: 'site-groups', origin: activeSite.origin, groups });
      showSites(result.sites);
      view('site-groups-dialog').close();
    } catch (error) {
      view('site-groups-status').textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sites) showSites(changes.sites.newValue);
  });
  return { showSites, setLibraries: next => { libraries = next; } };
}
