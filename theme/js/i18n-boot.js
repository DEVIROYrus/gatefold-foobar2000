/* Imported first by the page entry points: swaps the static Russian markup for the interface
   language before any other module runs (no music data is in the page yet). */
import { translateDom, $t } from './i18n.js';
translateDom(document.body);
if (/[А-Яа-яЁё]/.test(document.title)) document.title = $t(document.title);
