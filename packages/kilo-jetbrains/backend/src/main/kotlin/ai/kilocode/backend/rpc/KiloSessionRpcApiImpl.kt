@file:Suppress("UnstableApiUsage")

package ai.kilocode.backend.rpc

import ai.kilocode.backend.app.KiloBackendAppService
import ai.kilocode.backend.app.KiloBackendSessionManager
import ai.kilocode.rpc.KiloSessionRpcApi
import ai.kilocode.rpc.dto.SessionDto
import ai.kilocode.rpc.dto.SessionListDto
import ai.kilocode.rpc.dto.SessionStatusDto
import com.intellij.openapi.components.service
import kotlinx.coroutines.flow.Flow

/**
 * Backend implementation of [KiloSessionRpcApi].
 *
 * Delegates to [KiloBackendSessionManager] obtained from
 * [KiloBackendAppService.sessions]. The manager is guaranteed
 * to be started when the app is in [KiloAppState.Ready].
 */
class KiloSessionRpcApiImpl : KiloSessionRpcApi {

    private val manager: KiloBackendSessionManager
        get() = service<KiloBackendAppService>().sessions

    override suspend fun list(directory: String): SessionListDto =
        manager.list(directory)

    override suspend fun create(directory: String): SessionDto =
        manager.create(directory)

    override suspend fun get(id: String, directory: String): SessionDto =
        manager.get(id, directory)

    override suspend fun delete(id: String, directory: String) =
        manager.delete(id, directory)

    override suspend fun statuses(): Flow<Map<String, SessionStatusDto>> =
        manager.statuses

    override suspend fun setDirectory(id: String, directory: String) =
        manager.setDirectory(id, directory)

    override suspend fun getDirectory(id: String, fallback: String): String =
        manager.getDirectory(id, fallback)
}
