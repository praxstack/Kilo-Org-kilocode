@file:Suppress("UnstableApiUsage")

package ai.kilocode.backend.rpc

import ai.kilocode.rpc.dto.ConnectionStateDto
import ai.kilocode.rpc.dto.HealthDto
import ai.kilocode.backend.KiloBackendProjectService
import ai.kilocode.rpc.KiloProjectRpcApi
import com.intellij.openapi.components.service
import com.intellij.platform.project.ProjectId
import com.intellij.platform.project.findProjectOrNull
import kotlinx.coroutines.flow.Flow

/**
 * Backend implementation of [ai.kilocode.rpc.KiloProjectRpcApi].
 *
 * Resolves the project from the [ProjectId] passed by the frontend
 * and delegates to the project-level [KiloBackendProjectService].
 */
class KiloProjectRpcApiImpl : KiloProjectRpcApi {

    private fun resolve(id: ProjectId): KiloBackendProjectService {
        val project = id.findProjectOrNull()
            ?: throw IllegalStateException("Project not found for id: $id")
        return project.service()
    }

    override suspend fun connect(projectId: ProjectId) =
        resolve(projectId).connect()

    override suspend fun state(projectId: ProjectId): Flow<ConnectionStateDto> =
        resolve(projectId).stream()

    override suspend fun health(projectId: ProjectId): HealthDto =
        resolve(projectId).health()

    override suspend fun restart(projectId: ProjectId) =
        resolve(projectId).restart()

    override suspend fun reinstall(projectId: ProjectId) =
        resolve(projectId).reinstall()
}
