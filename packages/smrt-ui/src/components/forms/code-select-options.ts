import { ISO_4217_MINOR_UNITS } from '../display/currency-metadata.js';
import type { CodeSelectOption } from './code-select-types.js';

// ISO 3166-1 alpha-2 and ISO 3166-2 CA/US snapshot from iso-codes 4.20.1.
// https://salsa.debian.org/iso-codes-team/iso-codes (data, no runtime dependency).
const countries =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );
const regions: Record<string, readonly CodeSelectOption[]> = {
  CA: [
    {
      value: 'AB',
      label: 'Alberta',
    },
    {
      value: 'BC',
      label: 'British Columbia',
    },
    {
      value: 'MB',
      label: 'Manitoba',
    },
    {
      value: 'NB',
      label: 'New Brunswick',
    },
    {
      value: 'NL',
      label: 'Newfoundland and Labrador',
    },
    {
      value: 'NS',
      label: 'Nova Scotia',
    },
    {
      value: 'NT',
      label: 'Northwest Territories',
    },
    {
      value: 'NU',
      label: 'Nunavut',
    },
    {
      value: 'ON',
      label: 'Ontario',
    },
    {
      value: 'PE',
      label: 'Prince Edward Island',
    },
    {
      value: 'QC',
      label: 'Quebec',
    },
    {
      value: 'SK',
      label: 'Saskatchewan',
    },
    {
      value: 'YT',
      label: 'Yukon',
    },
  ],
  US: [
    {
      value: 'AK',
      label: 'Alaska',
    },
    {
      value: 'AL',
      label: 'Alabama',
    },
    {
      value: 'AR',
      label: 'Arkansas',
    },
    {
      value: 'AS',
      label: 'American Samoa',
    },
    {
      value: 'AZ',
      label: 'Arizona',
    },
    {
      value: 'CA',
      label: 'California',
    },
    {
      value: 'CO',
      label: 'Colorado',
    },
    {
      value: 'CT',
      label: 'Connecticut',
    },
    {
      value: 'DC',
      label: 'District of Columbia',
    },
    {
      value: 'DE',
      label: 'Delaware',
    },
    {
      value: 'FL',
      label: 'Florida',
    },
    {
      value: 'GA',
      label: 'Georgia',
    },
    {
      value: 'GU',
      label: 'Guam',
    },
    {
      value: 'HI',
      label: 'Hawaii',
    },
    {
      value: 'IA',
      label: 'Iowa',
    },
    {
      value: 'ID',
      label: 'Idaho',
    },
    {
      value: 'IL',
      label: 'Illinois',
    },
    {
      value: 'IN',
      label: 'Indiana',
    },
    {
      value: 'KS',
      label: 'Kansas',
    },
    {
      value: 'KY',
      label: 'Kentucky',
    },
    {
      value: 'LA',
      label: 'Louisiana',
    },
    {
      value: 'MA',
      label: 'Massachusetts',
    },
    {
      value: 'MD',
      label: 'Maryland',
    },
    {
      value: 'ME',
      label: 'Maine',
    },
    {
      value: 'MI',
      label: 'Michigan',
    },
    {
      value: 'MN',
      label: 'Minnesota',
    },
    {
      value: 'MO',
      label: 'Missouri',
    },
    {
      value: 'MP',
      label: 'Northern Mariana Islands',
    },
    {
      value: 'MS',
      label: 'Mississippi',
    },
    {
      value: 'MT',
      label: 'Montana',
    },
    {
      value: 'NC',
      label: 'North Carolina',
    },
    {
      value: 'ND',
      label: 'North Dakota',
    },
    {
      value: 'NE',
      label: 'Nebraska',
    },
    {
      value: 'NH',
      label: 'New Hampshire',
    },
    {
      value: 'NJ',
      label: 'New Jersey',
    },
    {
      value: 'NM',
      label: 'New Mexico',
    },
    {
      value: 'NV',
      label: 'Nevada',
    },
    {
      value: 'NY',
      label: 'New York',
    },
    {
      value: 'OH',
      label: 'Ohio',
    },
    {
      value: 'OK',
      label: 'Oklahoma',
    },
    {
      value: 'OR',
      label: 'Oregon',
    },
    {
      value: 'PA',
      label: 'Pennsylvania',
    },
    {
      value: 'PR',
      label: 'Puerto Rico',
    },
    {
      value: 'RI',
      label: 'Rhode Island',
    },
    {
      value: 'SC',
      label: 'South Carolina',
    },
    {
      value: 'SD',
      label: 'South Dakota',
    },
    {
      value: 'TN',
      label: 'Tennessee',
    },
    {
      value: 'TX',
      label: 'Texas',
    },
    {
      value: 'UM',
      label: 'United States Minor Outlying Islands',
    },
    {
      value: 'UT',
      label: 'Utah',
    },
    {
      value: 'VA',
      label: 'Virginia',
    },
    {
      value: 'VI',
      label: 'Virgin Islands, U.S.',
    },
    {
      value: 'VT',
      label: 'Vermont',
    },
    {
      value: 'WA',
      label: 'Washington',
    },
    {
      value: 'WI',
      label: 'Wisconsin',
    },
    {
      value: 'WV',
      label: 'West Virginia',
    },
    {
      value: 'WY',
      label: 'Wyoming',
    },
  ],
};

function displayNames(
  locale: string,
  type: 'currency' | 'region',
): Intl.DisplayNames {
  try {
    return new Intl.DisplayNames(locale, { type });
  } catch {
    return new Intl.DisplayNames('en', { type });
  }
}
/**
 * ISO 4217 codes that are not circulating currencies: funds codes, precious
 * metals, the IMF unit and bond-market units, and the testing / "no currency"
 * codes. They stay valid stored values (the select retains an unknown value)
 * but are not offered as choices.
 */
export const NON_CIRCULATING_CURRENCY_CODES: ReadonlySet<string> = new Set([
  // Funds codes
  'BOV',
  'CHE',
  'CHW',
  'CLF',
  'COU',
  'MXV',
  'USN',
  'USS',
  'UYI',
  'UYW',
  // Precious metals
  'XAG',
  'XAU',
  'XPD',
  'XPT',
  // Bond-market units, IMF special drawing rights, other supranational units
  'XBA',
  'XBB',
  'XBC',
  'XBD',
  'XDR',
  'XSU',
  'XUA',
  // Testing and "no currency"
  'XTS',
  'XXX',
]);
/** Build localized choices for circulating currencies from the shared ISO metadata. */
export function currencyOptions(locale: string): CodeSelectOption[] {
  const names = displayNames(locale, 'currency');
  return [...ISO_4217_MINOR_UNITS.keys()]
    .filter((value) => !NON_CIRCULATING_CURRENCY_CODES.has(value))
    .sort()
    .flatMap((value) => {
      const name = names.of(value);
      // A code the runtime cannot name (shown as "XYZ — XYZ") is not a currency to offer.
      if (!name || name === value) return [];
      return [{ value, label: `${value} — ${name}` }];
    });
}
/** Build localized ISO alpha-2 country choices. */
export function countryOptions(locale: string): CodeSelectOption[] {
  const names = displayNames(locale, 'region');
  return countries.map((value) => ({ value, label: names.of(value) ?? value }));
}
/** Return CA/US subdivision choices, or undefined for free-text countries. */
export function provinceOptions(
  country: string,
): readonly CodeSelectOption[] | undefined {
  return regions[country.toUpperCase()];
}
