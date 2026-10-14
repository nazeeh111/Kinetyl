# Security policy

Report a vulnerability privately through this repository's GitHub security advisory reporting channel. Include the affected version, a minimal input, expected trust boundary and observed impact. Please do not publish sensitive reproduction details before coordination.

Only the current released version is supported. Scene and plan imports are bounded structured data, not executable Python or JavaScript. They may still contain personal text and coordinates; portable exports deliberately include that source data. Do not share an export you intend to keep private.

The optional native renderer runs in your process and uses installed fonts, native code and a graphics adapter. It is not a sandbox. Unsigned input measurements and receipts are not authenticated evidence. Exact model verification is a correctness check within the declared geometry, not a whole-system security certificate.
