package ai.kilocode.backend.project

import ai.kilocode.backend.app.KiloAppState
import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.app.SseEvent
import ai.kilocode.backend.util.IntellijLog
import ai.kilocode.backend.util.KiloLog
import ai.kilocode.jetbrains.api.client.DefaultApi
import ai.kilocode.jetbrains.api.model.Agent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * Project-level backend service that loads project-scoped data
 * from the CLI server when the app reaches [KiloAppState.Ready].
 *
 * Construction is side-effect-free — call [start] to begin
 * watching [KiloBackendAppService.appState] and loading data.
 * [start] is idempotent and safe to call multiple times.
 *
 * Each fetch is retried up to [MAX_RETRIES] times, matching the
 * pattern in [KiloBackendAppService].
 */
@Service(Service.Level.PROJECT)
class KiloBackendProjectService private constructor(
    val directory: String,
    private val cs: CoroutineScope,
    private val appState: () -> StateFlow<KiloAppState>,
    private val api: () -> DefaultApi?,
    private val events: () -> SharedFlow<SseEvent>,
    private val log: KiloLog,
) {
    /** IntelliJ service injection entry point. */
    constructor(project: Project, cs: CoroutineScope) : this(
        directory = project.basePath ?: "",
        cs = cs,
        appState = { service<KiloBackendAppService>().appState },
        api = { service<KiloBackendAppService>().api },
        events = { service<KiloBackendAppService>().events },
        log = IntellijLog(KiloBackendProjectService::class.java),
    )

    companion object {
        private const val MAX_RETRIES = 3
        private const val RETRY_DELAY_MS = 1000L

        /** Test factory — no IntelliJ deps needed. */
        internal fun create(
            dir: String,
            cs: CoroutineScope,
            appState: () -> StateFlow<KiloAppState>,
            api: () -> DefaultApi?,
            log: KiloLog,
            events: () -> SharedFlow<SseEvent> = { MutableStateFlow(SseEvent("", "")) },
        ) = KiloBackendProjectService(dir, cs, appState, api, events, log)
    }

    private val _state = MutableStateFlow<KiloProjectState>(KiloProjectState.Pending)
    val state: StateFlow<KiloProjectState> = _state.asStateFlow()

    private var watcher: Job? = null
    private var loader: Job? = null
    private var eventWatcher: Job? = null

    /**
     * Begin watching app state and loading project data when ready.
     * Idempotent — safe to call multiple times.
     */
    fun start() {
        if (watcher?.isActive == true) return
        watcher = cs.launch {
            appState().collect { state ->
                when (state) {
                    is KiloAppState.Ready -> load()
                    is KiloAppState.Disconnected,
                    is KiloAppState.Connecting -> {
                        loader?.cancel()
                        _state.value = KiloProjectState.Pending
                    }
                    is KiloAppState.Error -> {
                        loader?.cancel()
                        _state.value = KiloProjectState.Pending
                    }
                    is KiloAppState.Loading -> { /* wait for Ready */ }
                }
            }
        }
    }

    /** Force a full reload of all project data. */
    suspend fun reload() {
        load()
    }

    /**
     * Launch all project data fetches in parallel.
     *
     * Cancels any in-flight load first. Each resource is retried
     * up to [MAX_RETRIES] times. Progress is tracked via
     * [AtomicReference] and emitted as [KiloProjectState.Loading].
     */
    private fun load() {
        loader?.cancel()
        loader = cs.launch {
            val dir = directory
            val client = api()
            if (client == null) {
                _state.value = KiloProjectState.Error("CLI server not connected")
                return@launch
            }

            log.info("Loading project data for $dir")
            val progress = AtomicReference(KiloProjectLoadProgress())
            _state.value = KiloProjectState.Loading(progress.get())

            var prov: ProviderData? = null
            var ag: AgentData? = null
            var cmd: List<CommandInfo>? = null
            var sk: List<SkillInfo>? = null
            val errors = mutableListOf<String>()

            try {
                coroutineScope {
                    launch {
                        val result = fetchWithRetry("providers") { fetchProviders(client, dir) }
                        if (result != null) {
                            prov = result
                            progress.updateAndGet { it.copy(providers = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("providers") }
                            throw LoadFailure("providers")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("agents") { fetchAgents(client, dir) }
                        if (result != null) {
                            ag = result
                            progress.updateAndGet { it.copy(agents = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("agents") }
                            throw LoadFailure("agents")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("commands") { fetchCommands(client, dir) }
                        if (result != null) {
                            cmd = result
                            progress.updateAndGet { it.copy(commands = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("commands") }
                            throw LoadFailure("commands")
                        }
                    }
                    launch {
                        val result = fetchWithRetry("skills") { fetchSkills(client, dir) }
                        if (result != null) {
                            sk = result
                            progress.updateAndGet { it.copy(skills = true) }
                                .also { _state.value = KiloProjectState.Loading(it) }
                        } else {
                            synchronized(errors) { errors.add("skills") }
                            throw LoadFailure("skills")
                        }
                    }
                }

                _state.value = KiloProjectState.Ready(
                    providers = prov!!,
                    agents = ag!!,
                    commands = cmd!!,
                    skills = sk!!,
                )
                log.info("Project data loaded for $dir")
                startWatchingGlobalSseEvents()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.warn("Project data load failed for $dir: ${e.message}")
                _state.value = KiloProjectState.Error(
                    "Failed to load: ${synchronized(errors) { errors.joinToString() }}"
                )
            }
        }
    }

    /**
     * Watch global SSE events that invalidate project-scoped data.
     *
     * - `global.disposed` — the CLI server's global context was torn down.
     *   All cached providers, agents, commands, and skills are stale — reload.
     *
     * - `server.instance.disposed` — a specific server instance was disposed.
     *   Same effect — reload project data to pick up the new state.
     *
     * Idempotent — only one watcher runs at a time.
     */
    private fun startWatchingGlobalSseEvents() {
        if (eventWatcher?.isActive == true) return
        log.info("Started watching global SSE events for project $directory")
        eventWatcher = cs.launch {
            events().collect { event ->
                when (event.type) {
                    // CLI server context torn down — all project data is stale
                    "global.disposed" -> {
                        log.info("SSE global.disposed — reloading project data for $directory")
                        load()
                    }
                    // Server instance disposed — same effect, reload project data
                    "server.instance.disposed" -> {
                        log.info("SSE server.instance.disposed — reloading project data for $directory")
                        load()
                    }
                }
            }
        }
    }

    // ------ individual fetch methods ------

    private fun fetchProviders(client: DefaultApi, dir: String): ProviderData? =
        try {
            val response = client.providerList(directory = dir)
            ProviderData(
                providers = response.all.map { p ->
                    ProviderInfo(
                        id = p.id,
                        name = p.name,
                        source = p.api,
                        models = p.models.mapValues { (_, m) ->
                            ModelInfo(
                                id = m.id,
                                name = m.name,
                                attachment = m.attachment,
                                reasoning = m.reasoning,
                                temperature = m.temperature,
                                toolCall = m.toolCall,
                                free = m.isFree ?: false,
                                status = m.status?.value,
                            )
                        },
                    )
                },
                connected = response.connected,
                defaults = response.default,
            )
        } catch (e: Exception) {
            log.warn("Providers fetch failed: ${e.message}", e)
            null
        }

    private fun fetchAgents(client: DefaultApi, dir: String): AgentData? =
        try {
            val response = client.appAgents(directory = dir)
            val mapped = response.map(::mapAgent)
            val visible = response.filter { it.mode != Agent.Mode.SUBAGENT && it.hidden != true }
            AgentData(
                agents = visible.map(::mapAgent),
                all = mapped,
                default = visible.firstOrNull()?.name ?: "code",
            )
        } catch (e: Exception) {
            log.warn("Agents fetch failed: ${e.message}", e)
            null
        }

    private fun fetchCommands(client: DefaultApi, dir: String): List<CommandInfo>? =
        try {
            client.commandList(directory = dir).map { c ->
                CommandInfo(
                    name = c.name,
                    description = c.description,
                    source = c.source?.value,
                    hints = c.hints,
                )
            }
        } catch (e: Exception) {
            log.warn("Commands fetch failed: ${e.message}", e)
            null
        }

    private fun fetchSkills(client: DefaultApi, dir: String): List<SkillInfo>? =
        try {
            client.appSkills(directory = dir).map { s ->
                SkillInfo(
                    name = s.name,
                    description = s.description,
                    location = s.location,
                )
            }
        } catch (e: Exception) {
            log.warn("Skills fetch failed: ${e.message}", e)
            null
        }

    // ------ helpers ------

    private fun mapAgent(a: Agent) = AgentInfo(
        name = a.name,
        displayName = a.displayName,
        description = a.description,
        mode = a.mode.value,
        native = a.native,
        hidden = a.hidden,
        color = a.color,
        deprecated = a.deprecated,
    )

    private suspend fun <T> fetchWithRetry(
        name: String,
        block: () -> T?,
    ): T? {
        repeat(MAX_RETRIES) { attempt ->
            val result = block()
            if (result != null) return result
            if (attempt < MAX_RETRIES - 1) {
                log.warn("$name: attempt ${attempt + 1}/$MAX_RETRIES failed — retrying in ${RETRY_DELAY_MS}ms")
                delay(RETRY_DELAY_MS)
            }
        }
        log.error("$name: all $MAX_RETRIES attempts failed")
        return null
    }

    private class LoadFailure(resource: String) : Exception("Failed to load $resource")
}
