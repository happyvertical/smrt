function minorUnitEntries(
  codes: string,
  minorUnits: number | null,
): Array<[string, number | null]> {
  return codes.split(' ').map((code) => [code, minorUnits]);
}

// ISO 4217 List One, published by the ISO maintenance agency SIX on
// 2026-01-01. Keeping both membership and minor-unit exponents here makes SSR
// and browser rendering independent of their potentially different ICU data.
// Source: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
export const ISO_4217_MINOR_UNITS = new Map<string, number | null>([
  ...minorUnitEntries(
    'XOF BIF XAF CLP KMF DJF XPF GNF ISK JPY KRW PYG RWF UGX UYI VUV VND',
    0,
  ),
  ...minorUnitEntries(
    'AFN EUR ALL DZD USD AOA XCD XAD ARS AMD AWG AUD AZN BSD BDT BBD BYN BZD BMD INR BTN BOB BOV BAM BWP NOK BRL BND CVE KHR CAD KYD CNY COP COU CDF NZD CRC CUP XCG CZK DKK DOP EGP SVC ERN SZL ETB FKP FJD GMD GEL GHS GIP GTQ GBP GYD HTG HNL HKD HUF IDR IRR ILS JMD KZT KES KPW KGS LAK LBP LSL ZAR LRD CHF MOP MKD MGA MWK MYR MVR MRU MUR MXN MXV MDL MNT MAD MZN MMK NAD NPR NIO NGN PKR PAB PGK PEN PHP PLN QAR RON RUB SHP WST STN SAR RSD SCR SLE SGD SBD SOS SSP LKR SDG SRD SEK CHE CHW SYP TWD TJS TZS THB TOP TTD TRY TMT UAH AED USN UYU UZS VES VED YER ZMW ZWG',
    2,
  ),
  ...minorUnitEntries('BHD IQD JOD KWD LYD OMR TND', 3),
  ...minorUnitEntries('CLF UYW', 4),
  ...minorUnitEntries(
    'XDR XUA XSU XBA XBB XBC XBD XTS XXX XAU XPD XPT XAG',
    null,
  ),
]);
