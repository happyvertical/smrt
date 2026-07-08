package com.happyvertical.smrt.android.sample

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.happyvertical.smrt.android.platform.AndroidDeviceCapabilityAdapter
import com.happyvertical.smrt.android.platform.AndroidSqlDriverFactory
import com.happyvertical.smrt.android.platform.AndroidSpeechTranscriber
import com.happyvertical.smrt.android.platform.GeminiNanoLanguageModel
import com.happyvertical.smrt.android.platform.MlKitBarcodeScanner
import com.happyvertical.smrt.android.ui.BarcodeScannerPreview
import com.happyvertical.smrt.android.ui.MobileResultCard
import com.happyvertical.smrt.android.ui.MobileSectionLabel
import com.happyvertical.smrt.android.ui.MobileShellScaffold
import com.happyvertical.smrt.android.ui.MobileStatusPill
import com.happyvertical.smrt.android.ui.MobileTabHeader
import com.happyvertical.smrt.android.ui.MobileTheme
import com.happyvertical.smrt.mobile.db.SmrtMobileDatabase
import com.happyvertical.smrt.mobile.platform.BarcodeScan
import com.happyvertical.smrt.mobile.platform.BarcodeScanListener
import com.happyvertical.smrt.mobile.platform.BarcodeScanRequest
import com.happyvertical.smrt.mobile.platform.LanguageModelAvailability
import com.happyvertical.smrt.mobile.platform.SpeechListenRequest
import com.happyvertical.smrt.mobile.platform.SpeechTranscriptListener
import com.happyvertical.smrt.mobile.shell.MobileShellState
import com.happyvertical.smrt.mobile.shell.MobileTab
import com.happyvertical.smrt.mobile.sync.DurableWriteQueue
import com.happyvertical.smrt.mobile.sync.NewQueueEntry
import com.happyvertical.smrt.mobile.sync.QueueStats
import java.util.UUID
import kotlinx.coroutines.launch

private object SampleTabs {
    const val HOME = "home"
    const val SCAN = "scan"
    const val TALK = "talk"
    const val SETTINGS = "settings"

    val all = listOf(
        MobileTab(id = HOME, label = "Home"),
        MobileTab(id = SCAN, label = "Scan"),
        MobileTab(id = TALK, label = "Talk"),
        MobileTab(id = SETTINGS, label = "Settings"),
    )

    fun icon(tabId: String): ImageVector = when (tabId) {
        SCAN -> Icons.Outlined.QrCodeScanner
        TALK -> Icons.Outlined.Mic
        SETTINGS -> Icons.Outlined.Settings
        else -> Icons.Outlined.Home
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MobileTheme {
                SampleShell()
            }
        }
    }
}

@Composable
private fun SampleShell() {
    var shellState by remember {
        mutableStateOf(
            MobileShellState(
                brandName = "SMRT Android Sample",
                tabs = SampleTabs.all,
                selectedTabId = SampleTabs.HOME,
            ),
        )
    }
    // One queue per database (the queue contract) — created once at shell
    // level, not per tab visit.
    val context = LocalContext.current
    val queue = remember {
        DurableWriteQueue(
            SmrtMobileDatabase(AndroidSqlDriverFactory(context).createDriver()),
        )
    }

    MobileShellScaffold(
        state = shellState,
        onSelectTab = { tabId -> shellState = shellState.select(tabId) },
        tabIcon = { tab, _ ->
            Icon(imageVector = SampleTabs.icon(tab.id), contentDescription = tab.label)
        },
    ) { selected, padding ->
        val tabModifier = Modifier
            .fillMaxSize()
            .padding(padding)

        when (selected.id) {
            SampleTabs.SCAN -> ScanTab(tabModifier)
            SampleTabs.TALK -> TalkTab(tabModifier)
            SampleTabs.SETTINGS -> SettingsTab(tabModifier)
            else -> HomeTab(tabModifier, brandName = shellState.brandName, queue = queue)
        }
    }
}

@Composable
private fun HomeTab(modifier: Modifier, brandName: String, queue: DurableWriteQueue) {
    val scope = rememberCoroutineScope()
    var stats by remember { mutableStateOf<QueueStats?>(null) }

    LaunchedEffect(queue) {
        queue.recoverInterrupted()
        stats = queue.stats()
    }

    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(MobileTheme.spacing.screenPadding),
        verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.sectionGap),
    ) {
        MobileTabHeader(
            title = brandName,
            subtitle = "MobileShellScaffold + MobileTheme over smrt-mobile's shell state",
        )

        MobileSectionLabel("Status colors")
        MobileResultCard(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.padding(MobileTheme.spacing.itemGap),
                horizontalArrangement = Arrangement.spacedBy(MobileTheme.spacing.tightGap),
            ) {
                MobileStatusPill("Stop", MobileTheme.statusColors.stop)
                MobileStatusPill("Caution", MobileTheme.statusColors.caution)
                MobileStatusPill("Go", MobileTheme.statusColors.go)
                MobileStatusPill("Info", MobileTheme.statusColors.info)
                MobileStatusPill("Neutral", MobileTheme.statusColors.neutral)
            }
        }

        MobileSectionLabel("Durable write-queue", trailing = "AndroidSqlDriverFactory")
        MobileResultCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(MobileTheme.spacing.itemGap),
                verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.tightGap),
            ) {
                val current = stats
                Text(
                    if (current == null) {
                        "Opening smrt_mobile.db…"
                    } else {
                        "${current.pending} pending · ${current.uploading} uploading · ${current.failed} failed"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(
                    onClick = {
                        scope.launch {
                            queue.enqueue(
                                NewQueueEntry(
                                    id = UUID.randomUUID().toString(),
                                    kind = "sample_note",
                                    payload = """{"note":"enqueued from the sample app"}""",
                                ),
                            )
                            stats = queue.stats()
                        }
                    },
                ) {
                    Text("Enqueue sample entry")
                }
            }
        }
    }
}

@Composable
private fun ScanTab(modifier: Modifier) {
    val context = LocalContext.current
    val scanner = remember { MlKitBarcodeScanner(context.applicationContext) }
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasCameraPermission = granted }
    var scans by remember { mutableStateOf(listOf<BarcodeScan>()) }

    DisposableEffect(scanner, hasCameraPermission) {
        if (hasCameraPermission) {
            scanner.startScanning(
                request = BarcodeScanRequest(),
                listener = object : BarcodeScanListener {
                    override fun onBarcode(scan: BarcodeScan) {
                        if (scans.firstOrNull()?.rawValue != scan.rawValue) {
                            scans = (listOf(scan) + scans).take(5)
                        }
                    }
                },
            )
        }
        onDispose { scanner.stopScanning() }
    }

    Column(
        modifier = modifier.padding(MobileTheme.spacing.screenPadding),
        verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.sectionGap),
    ) {
        MobileTabHeader(
            title = "Barcode",
            subtitle = "MlKitBarcodeScanner through BarcodeScannerPreview",
        )

        if (!hasCameraPermission) {
            MobileResultCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(MobileTheme.spacing.itemGap),
                    verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.itemGap),
                ) {
                    Text(
                        "Camera permission is needed to scan.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = { requestPermission.launch(Manifest.permission.CAMERA) }) {
                        Text("Grant camera access")
                    }
                }
            }
        } else {
            BarcodeScannerPreview(
                scanner = scanner,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(280.dp),
            )
            MobileSectionLabel("Recent scans", trailing = "${scans.size}")
            scans.forEach { scan ->
                MobileResultCard(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(MobileTheme.spacing.itemGap)) {
                        Text(scan.rawValue, style = MaterialTheme.typography.bodyLarge)
                        Text(
                            scan.format,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TalkTab(modifier: Modifier) {
    val context = LocalContext.current
    val transcriber = remember { AndroidSpeechTranscriber(context.applicationContext) }
    val model = remember { GeminiNanoLanguageModel() }
    val scope = rememberCoroutineScope()

    var hasMicPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasMicPermission = granted }

    var availability by remember { mutableStateOf<LanguageModelAvailability?>(null) }
    var transcript by remember { mutableStateOf("") }
    var listening by remember { mutableStateOf(false) }
    var modelOutput by remember { mutableStateOf("") }

    LaunchedEffect(model) {
        availability = model.checkAvailability()
    }
    DisposableEffect(transcriber) {
        onDispose { transcriber.destroy() }
    }

    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(MobileTheme.spacing.screenPadding),
        verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.sectionGap),
    ) {
        MobileTabHeader(
            title = "Talk",
            subtitle = "AndroidSpeechTranscriber + GeminiNanoLanguageModel",
        )

        MobileSectionLabel("On-device model")
        MobileResultCard(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(MobileTheme.spacing.itemGap)) {
                val current = availability
                if (current == null) {
                    Text("Checking Gemini Nano…", style = MaterialTheme.typography.bodyMedium)
                } else {
                    val color = if (current.onDeviceReady) {
                        MobileTheme.statusColors.go
                    } else {
                        MobileTheme.statusColors.caution
                    }
                    MobileStatusPill(current.status, color)
                    if (current.reason.isNotBlank()) {
                        Text(
                            current.reason,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        MobileSectionLabel("Transcription")
        MobileResultCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(MobileTheme.spacing.itemGap),
                verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.itemGap),
            ) {
                Text(
                    transcript.ifBlank { "Transcript appears here." },
                    style = MaterialTheme.typography.bodyLarge,
                )
                if (!hasMicPermission) {
                    Button(onClick = { requestPermission.launch(Manifest.permission.RECORD_AUDIO) }) {
                        Text("Grant microphone access")
                    }
                } else if (!listening) {
                    Button(
                        onClick = {
                            if (!transcriber.isAvailable()) {
                                transcript = "Speech recognition is unavailable on this device."
                                return@Button
                            }
                            listening = true
                            transcriber.startListening(
                                request = SpeechListenRequest(),
                                listener = object : SpeechTranscriptListener {
                                    override fun onPartialTranscript(text: String) {
                                        transcript = text
                                    }

                                    override fun onFinalTranscript(text: String) {
                                        transcript = text
                                        listening = false
                                    }

                                    override fun onError(code: String) {
                                        transcript = "[$code]"
                                        listening = false
                                    }
                                },
                            )
                        },
                    ) {
                        Text("Start listening")
                    }
                } else {
                    OutlinedButton(onClick = { transcriber.stopListening() }) {
                        Text("Stop")
                    }
                }

                if (availability?.onDeviceReady == true && transcript.isNotBlank() && !listening) {
                    Button(
                        onClick = {
                            scope.launch {
                                modelOutput = runCatching { model.generate(transcript) }
                                    .getOrElse { error -> "[${error.message}]" }
                            }
                        },
                    ) {
                        Text("Interpret on-device")
                    }
                    if (modelOutput.isNotBlank()) {
                        Text(modelOutput, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsTab(modifier: Modifier) {
    val context = LocalContext.current
    var probeVersion by remember { mutableIntStateOf(0) }
    // Feeds the adapter's tri-state model: permissions we have fired a
    // system dialog for report `denied` (not `not_determined`) afterwards.
    // In-memory is enough for the sample; real apps persist this.
    val requestedPermissions = remember { mutableSetOf<String>() }
    val capabilities = remember(probeVersion) {
        AndroidDeviceCapabilityAdapter(
            context,
            permissionRequestHistory = { permission -> permission in requestedPermissions },
        ).currentCapabilities()
    }
    val requestPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        requestedPermissions.addAll(results.keys)
        probeVersion += 1
    }

    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(MobileTheme.spacing.screenPadding),
        verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.sectionGap),
    ) {
        MobileTabHeader(
            title = "Settings",
            subtitle = "AndroidDeviceCapabilityAdapter probe",
        )

        MobileSectionLabel("Capture surfaces")
        listOf(capabilities.camera, capabilities.microphone).forEach { capability ->
            MobileResultCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(MobileTheme.spacing.itemGap),
                    verticalArrangement = Arrangement.spacedBy(MobileTheme.spacing.tightGap),
                ) {
                    Text(capability.label, style = MaterialTheme.typography.titleMedium)
                    val color = when (capability.permission.status) {
                        "granted" -> MobileTheme.statusColors.go
                        "not_determined" -> MobileTheme.statusColors.info
                        "denied" -> MobileTheme.statusColors.caution
                        else -> MobileTheme.statusColors.neutral
                    }
                    MobileStatusPill(capability.permission.status, color)
                    capability.permission.reason?.takeIf { it.isNotBlank() }?.let { reason ->
                        Text(
                            reason,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        Button(
            onClick = {
                requestPermissions.launch(
                    arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO),
                )
            },
        ) {
            Text("Request camera + microphone")
        }
    }
}
