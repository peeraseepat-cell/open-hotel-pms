"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { MaintenanceTask } from "@/lib/types";
import { MaintenanceTaskFormModal, MaintenanceTaskFormPayload } from "@/components/pms/maintenance/task-form-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { PlusIcon, EditIcon, AlertTriangle, RefreshCwIcon, Trash2Icon, RotateCcwIcon, LayersIcon, ShieldCheckIcon } from "lucide-react";

type ApiResponse<T extends Record<string, unknown> = Record<string, unknown>> = {
    success?: boolean;
    error?: string;
} & T;

async function readJsonSafe<T extends Record<string, unknown>>(response: Response): Promise<ApiResponse<T>> {
    try {
        return (await response.json()) as ApiResponse<T>;
    } catch {
        return {} as ApiResponse<T>;
    }
}

export default function MaintenanceTasksPage() {
    const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState("");
    const { toast } = useToast();

    const [modalOpen, setModalOpen] = useState(false);
    const [selectedTask, setSelectedTask] = useState<MaintenanceTask | null>(null);
    const [processingId, setProcessingId] = useState<string | null>(null);

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

    const fetchTasks = useCallback(async () => {
        try {
            setIsLoading(true);
            const res = await fetch("/api/maintenance/tasks");
            const data = await readJsonSafe<{ tasks?: MaintenanceTask[] }>(res);
            if (!res.ok || data.success !== true || !Array.isArray(data.tasks)) {
                throw new Error(data.error || "Failed to fetch maintenance tasks");
            }
            setTasks(data.tasks);
        } catch (err) {
            toast({
                title: "Error",
                description: err instanceof Error ? err.message : "Failed to fetch maintenance tasks",
                variant: "destructive"
            });
        } finally { setIsLoading(false); }
    }, [toast]);

    useEffect(() => { fetchTasks(); }, [fetchTasks]);

    const handleCreateOrUpdate = async (data: MaintenanceTaskFormPayload) => {
        const isEditing = !!selectedTask;
        const url = isEditing ? `/api/maintenance/tasks/${selectedTask.id}` : "/api/maintenance/tasks";
        const method = isEditing ? "PUT" : "POST";
        const { times = [], ...taskPayload } = data;

        const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(taskPayload) });
        const result = await readJsonSafe<{ task?: { id?: string } }>(res);
        if (!res.ok || result.success === false) throw new Error(result.error || "Error saving data");

        const taskId = isEditing ? selectedTask?.id : result.task?.id;
        if (taskId) {
            const timesRes = await fetch(`/api/maintenance/tasks/${taskId}/times`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ times }),
            });
            const timesResult = await readJsonSafe(timesRes);
            if (!timesRes.ok || timesResult.success === false) throw new Error(timesResult.error || "Error saving estimated times");
        }

        toast({ title: "Success", description: `Task "${taskPayload.name}" saved` });
        fetchTasks();
    };

    const handleToggleActive = async (id: string, current: boolean) => {
        try {
            setProcessingId(id);
            const res = await fetch(`/api/maintenance/tasks/${id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_active: !current })
            });
            const data = await readJsonSafe(res);
            if (!res.ok || data.success === false) throw new Error(data.error || "Update failed");
            toast({ title: "Success", description: !current ? "Task activated" : "Task deactivated" });
            setTasks(tasks.map(t => t.id === id ? { ...t, is_active: !current } : t));
        } catch (error: any) {
            toast({ title: "Error", description: error?.message || "Failed to change status", variant: "destructive" });
        } finally { setProcessingId(null); }
    };

    const handleConfirmDelete = async () => {
        if (!deleteTarget) return;
        try {
            setProcessingId(deleteTarget.id);
            const res = await fetch(`/api/maintenance/tasks/${deleteTarget.id}`, { method: "DELETE" });
            const data = await readJsonSafe(res);
            if (!res.ok || data.success === false) throw new Error(data.error || "Delete failed");
            toast({ title: "Success", description: `Deactivated ${deleteTarget.name}` });
            // Retire in place — mirrors handleToggleActive. Filtering the row out here
            // would contradict the server, which keeps the task (is_active=false) so it
            // stays reactivable; the row would silently return on the next refresh.
            setTasks(tasks.map(t => t.id === deleteTarget.id ? { ...t, is_active: false } : t));
        } catch (error: any) {
            toast({ title: "Error", description: error?.message || "Failed to deactivate", variant: "destructive" });
        } finally { setProcessingId(null); setDeleteTarget(null); }
    };

    const filteredTasks = useMemo(() => {
        let sorted = [...tasks].sort((a, b) => Number(b.is_active) - Number(a.is_active));
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            sorted = sorted.filter(t => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q));
        }
        return sorted;
    }, [tasks, searchQuery]);

    const activeCount = tasks.filter(t => t.is_active).length;
    const inactiveCount = tasks.filter(t => !t.is_active).length;

    return (
        <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-red-600">Maintenance</p>
                    <h1 className="text-2xl font-bold text-[var(--text-primary)] tracking-tight">Task Definitions</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-0.5">
                        {activeCount} active &middot; {inactiveCount} inactive
                    </p>
                </div>
                <Button
                    onClick={() => { setSelectedTask(null); setModalOpen(true); }}
                    className="h-9 bg-[var(--text-primary)] text-[var(--bg-surface)] hover:opacity-90"
                >
                    <PlusIcon className="w-4 h-4 mr-1.5" /> Add New Task
                </Button>
            </div>

            {/* Search */}
            {tasks.length > 0 && (
                <div className="relative max-w-sm">
                    <Input
                        placeholder="Search tasks..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="h-9"
                    />
                </div>
            )}

            {/* Task List */}
            {isLoading ? (
                <div className="space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-28 animate-pulse rounded-xl bg-[var(--bg-muted)]" />)}
                </div>
            ) : (
                <div className="space-y-3">
                    {filteredTasks.map(task => (
                        <div
                            key={task.id}
                            className={`bg-[var(--bg-surface)] rounded-xl border overflow-hidden transition-all ${
                                task.is_active
                                    ? "border-l-4 border-l-sky-500 hover:shadow-md"
                                    : "opacity-50 border-l-4 border-l-slate-300"
                            }`}
                        >
                            <div className="p-4 sm:p-5">
                                {/* Top row */}
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h3 className="text-base font-bold text-[var(--text-primary)]">{task.name}</h3>
                                            {!task.is_active && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider bg-[var(--bg-muted)] text-[var(--text-muted)] px-2 py-0.5 rounded-full">Inactive</span>
                                            )}
                                            {task.sync_to_housekeeper && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                                                    <ShieldCheckIcon className="w-3 h-3" /> HK Sync
                                                </span>
                                            )}
                                        </div>
                                        {task.description && <p className="text-sm text-[var(--text-muted)] mt-1 line-clamp-2">{task.description}</p>}
                                    </div>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => { setSelectedTask(task); setModalOpen(true); }}
                                        disabled={processingId === task.id}
                                        className="h-8 text-xs shrink-0"
                                    >
                                        <EditIcon className="w-3.5 h-3.5 mr-1" /> Edit
                                    </Button>
                                </div>

                                {/* Thresholds + Room Types */}
                                <div className="flex flex-wrap items-center gap-2 mt-3">
                                    <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-md">
                                        <AlertTriangle className="w-3.5 h-3.5" /> Overdue: {task.threshold_count} stays
                                    </span>
                                    {task.warning_count && (
                                        <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-md">
                                            Warning: {task.warning_count} stays
                                        </span>
                                    )}
                                    <span className="text-[var(--text-muted)]">|</span>
                                    {task.applicable_room_types ? (
                                        <div className="flex flex-wrap gap-1">
                                            {task.applicable_room_types.map(code => (
                                                <span key={code} className="text-[10px] font-bold bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] px-2 py-0.5 rounded-full">{code}</span>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-xs text-[var(--text-muted)]">All Room Types</span>
                                    )}
                                </div>

                                {/* Checklist preview */}
                                {task.sync_to_housekeeper && task.checklist_items && task.checklist_items.length > 0 && (
                                    <p className="text-xs text-[var(--text-muted)] mt-2 pl-2 border-l-2 border-[var(--border-default)]">
                                        Checklist: {task.checklist_items.slice(0, 3).join(", ")}{task.checklist_items.length > 3 ? ` +${task.checklist_items.length - 3} more` : ""}
                                    </p>
                                )}

                                {/* Bottom actions */}
                                <div className="flex justify-end gap-2 mt-3 pt-3 border-t border-[var(--border-subtle)]">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => handleToggleActive(task.id, task.is_active)}
                                        disabled={processingId === task.id}
                                        className={`h-8 text-xs ${task.is_active ? "text-amber-600 hover:bg-amber-50" : "text-emerald-600 hover:bg-emerald-50"}`}
                                    >
                                        <RotateCcwIcon className="w-3.5 h-3.5 mr-1" />
                                        {task.is_active ? "Deactivate" : "Activate"}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setDeleteTarget({ id: task.id, name: task.name })}
                                        disabled={processingId === task.id}
                                        className="h-8 text-xs text-red-500 hover:bg-red-50 hover:text-red-600"
                                    >
                                        <Trash2Icon className="w-3.5 h-3.5" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ))}

                    {tasks.length === 0 && (
                        <div className="text-center py-16 bg-[var(--bg-body)] border-2 border-dashed rounded-xl">
                            <LayersIcon className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-3" />
                            <h3 className="text-lg font-medium text-[var(--text-secondary)]">No maintenance tasks yet</h3>
                            <p className="text-sm text-[var(--text-muted)] mt-1">Create tasks like AC cleaning or pipe flushing.</p>
                            <Button className="mt-4 h-9 bg-red-600 hover:bg-red-700" onClick={() => { setSelectedTask(null); setModalOpen(true); }}>
                                <PlusIcon className="w-4 h-4 mr-1.5" /> Create First Task
                            </Button>
                        </div>
                    )}

                    {tasks.length > 0 && filteredTasks.length === 0 && (
                        <div className="text-center py-12 text-[var(--text-muted)]">
                            <p>No tasks match &ldquo;{searchQuery}&rdquo;</p>
                        </div>
                    )}
                </div>
            )}

            {/* Deactivate Confirmation Modal */}
            <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Deactivate Task</DialogTitle>
                        <DialogDescription>
                            Deactivate &ldquo;{deleteTarget?.name}&rdquo;? It stops appearing on the board and can no longer be assigned. Its history and notes are kept, and you can reactivate it from this list.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setDeleteTarget(null)} className="h-9">Cancel</Button>
                        <Button className="h-9 bg-red-600 hover:bg-red-700" onClick={handleConfirmDelete} disabled={processingId !== null}>
                            {processingId ? "Deactivating..." : "Deactivate"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {modalOpen && (
                <MaintenanceTaskFormModal
                    task={selectedTask}
                    isOpen={modalOpen}
                    onOpenChange={setModalOpen}
                    onSave={handleCreateOrUpdate}
                />
            )}
        </div>
    );
}
