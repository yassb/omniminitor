import { addSite, listSites } from './db.js';

export const DEFAULT_SITES = [
  {
    name: 'UCA Marrakech - Official Candidature Portal',
    url: 'https://e-candidature.uca.ma/'
  },
  {
    name: 'UCA Marrakech FLAM - Master Applications 2026-2027',
    url: 'https://www.uca.ma/flam/fr/news/candidature-aux-masters-pour-lannee-universitaire-20262027'
  },
  {
    name: 'UCA Marrakech - FLA Master Candidature 2026-2027',
    url: 'https://e-candidature.uca.ma/master.fla/'
  },
  {
    name: 'UCA Marrakech - FLSH Master Candidature 2026-2027',
    url: 'https://e-candidature.uca.ma/master.flsh/'
  },
  {
    name: 'UCA Marrakech - ENS Master Candidature 2026-2027',
    url: 'https://e-candidature.uca.ma/master.ens/'
  },
  {
    name: 'FLSH Marrakech - Linguistics and Advanced English Studies',
    url: 'https://flsh.uca.ma/linguistics-and-advanced-english-studies/'
  },
  {
    name: 'UCA Marrakech - Linguistics and Advanced English Studies',
    url: 'https://www.uca.ma/fr/formations/formation-initiale/linguistics-and-advanced-english-studies'
  },
  {
    name: 'ENS Marrakech - Master Announcements',
    url: 'https://ens.uca.ma/'
  },
  {
    name: 'ESRFT Tanger - Traduction',
    url: 'https://esrft.ma/'
  },
  {
    name: 'FSE Rabat - Applied Linguistics and ELT',
    url: 'https://fse.um5.ac.ma/'
  },
  {
    name: 'ENS Rabat - Master Pre-registration 2026-2027',
    url: 'https://ens.um5.ac.ma/affiche-annonce-22'
  },
  {
    name: 'ENS Rabat - TESOL Programmes',
    url: 'https://ens.um5.ac.ma/coordonnateurs-des-filieres'
  },
  {
    name: 'ENS Meknes - English Masters',
    url: 'https://www.ens.umi.ac.ma/formations/master/'
  },
  {
    name: 'ENS Meknes - Official Registration Portal',
    url: 'https://ens-umi-inscription.com/'
  },
  {
    name: 'Ibn Zohr University - Applied Linguistics and ELT',
    url: 'https://www.uiz.ac.ma/node/182'
  },
  {
    name: 'UAE Tetouan - Interdisciplinary English Studies',
    url: 'https://www.uae.ac.ma/formations/flsh/interdisciplinary-studies-english-language-culture-literature-options-1'
  },
  {
    name: 'FSHS Kenitra - Masters',
    url: 'https://fshs.uit.ac.ma/%D8%A7%D9%84%D8%B4%D8%B9%D8%A8/%D8%A7%D9%84%D9%85%D8%A7%D8%B3%D8%AA%D8%B1/'
  },
  {
    name: 'UMP Oujda - Licence Professionnelle Litterature et Traduction',
    url: 'https://www.ump.ma/fr/licence-professionnelle-lp'
  },
  {
    name: 'FLASH Settat - English Masters',
    url: 'https://www-flash.uh1.ac.ma/'
  },
  {
    name: 'AlMaster Maroc - Master 2026-2027',
    url: 'https://www.almaster-maroc.com/'
  },
  {
    name: 'AlMaster Maroc - FLSH Masters',
    url: 'https://www.almaster-maroc.com/search/label/FLSH'
  },
  {
    name: 'AlMaster Maroc - FLA Masters',
    url: 'https://www.almaster-maroc.com/search/label/FLA'
  },
  {
    name: 'AlMaster Maroc - FLLA Masters',
    url: 'https://www.almaster-maroc.com/search/label/FLLA'
  },
  {
    name: 'AlMaster Maroc - FSHS Masters',
    url: 'https://www.almaster-maroc.com/search/label/FSHS'
  },
  {
    name: 'AlMaster Maroc - ESRFT Masters',
    url: 'https://www.almaster-maroc.com/search/label/ESRFT'
  },
  {
    name: 'AlMaster Maroc - FLASH Masters',
    url: 'https://www.almaster-maroc.com/search/label/FLASH'
  },
  {
    name: 'AlMaster Maroc - FSE Masters',
    url: 'https://www.almaster-maroc.com/search/label/FSE'
  },
  {
    name: 'Licence Professionnelle Maroc - 2026-2027',
    url: 'https://www.licence-professionnelle-maroc.com/'
  },
  {
    name: 'Licence Professionnelle Maroc - LP',
    url: 'https://www.licence-professionnelle-maroc.com/search/label/Licence%20Professionnelle'
  },
  {
    name: 'Licence Professionnelle Maroc - FLSH',
    url: 'https://www.licence-professionnelle-maroc.com/search/label/FLSH'
  },
  {
    name: 'Licence Professionnelle Maroc - FLASH',
    url: 'https://www.licence-professionnelle-maroc.com/search/label/FLASH'
  },
  {
    name: 'FS Dhar El Mahraz Fes - Master & Licence Excellence',
    url: 'https://www.fsdm.usmba.ac.ma/News/1218/show'
  },
  {
    name: 'Faculte Polydisciplinaire Beni Mellal - Concours',
    url: 'https://www.fpbm.ma/new/concours/'
  },
  {
    name: 'Faculte Polydisciplinaire Larache - Parcours Excellence',
    url: 'https://fpl.ac.ma/site/category/parcours-dexcellence/'
  }
];

export function seedDefaultSites(database) {
  const before = new Set(listSites(database).map((site) => site.url));
  const saved = DEFAULT_SITES.map((site) => addSite(database, site));
  const added = saved.filter((site) => !before.has(site.url)).length;

  return {
    added,
    total: saved.length,
    sites: saved
  };
}
