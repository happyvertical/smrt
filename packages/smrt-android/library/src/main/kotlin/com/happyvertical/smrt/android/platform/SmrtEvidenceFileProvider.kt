package com.happyvertical.smrt.android.platform

import androidx.core.content.FileProvider
import com.happyvertical.smrt.android.R

/**
 * Dedicated [FileProvider] subclass for library-shipped evidence capture
 * (issue #1880). A distinct class name is deliberate: the Android manifest
 * merger keys `<provider>` elements by their class, so declaring the base
 * `androidx.core.content.FileProvider` from a library would collide with a
 * consumer app's own FileProvider. The subclass passes the paths resource to
 * the super constructor, so the manifest needs no `<meta-data>`. The system
 * instantiates it via the generated no-arg constructor. Consumers never
 * reference it directly — it is wired entirely by the merged library manifest.
 */
class SmrtEvidenceFileProvider : FileProvider(R.xml.smrt_evidence_file_paths)
