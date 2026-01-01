# Product Guidelines - SMRT Framework

## 1. Tone and Voice
*   **Clinical and Precise:** All documentation, error messages, and system outputs must reflect a high degree of technical accuracy and formality. 
*   **Objective Authority:** Avoid colloquialisms or hype. The framework is a professional tool for engineers; its voice should be authoritative and reliable.
*   **Clarity Over Personality:** Focus entirely on enabling the user's work with maximum clarity and minimum distraction.

## 2. Visual and Structural Principles
*   **Information-Dense Design:** Prioritize high information density for expert users. Interfaces should provide comprehensive state and data views at a glance, minimizing the need for multiple paginated views.
*   **Balanced Hierarchy:** While dense, use clear grouping and subtle typography to maintain a visual hierarchy. This ensures that critical agent status or AI operations remain discoverable within rich data views.
*   **Structured Output:** Prefer structured data formats (JSON, tables) for machine-readable outputs, reinforcing the framework's suitability for automation.

## 3. Development Standards
*   **Type Safety as Documentation:** TypeScript types are the primary source of truth. Naming must be self-explanatory to minimize external documentation needs.
*   **Predictability:** Auto-generation must be deterministic. Users should be able to predict the generated schema or API structure based solely on their input class definition.
