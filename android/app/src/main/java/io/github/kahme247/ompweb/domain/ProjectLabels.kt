package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ManagedProject

/** Display label for a project: the alias, else the final folder name. */
fun projectLabel(project: ManagedProject): String =
    project.alias?.takeIf { it.isNotBlank() } ?: projectPathLabel(project.path)
