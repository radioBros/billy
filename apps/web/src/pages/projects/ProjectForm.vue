<script setup lang="ts">
/**
 * Project create/edit form. One component serves both routes: with an `:id`
 * route param it loads + PATCHes; without, it POSTs a new project. Validation
 * mirrors the backend Zod shape (projects/schema.ts): `name` required;
 * `description` + `color` optional. On edit, `status` (active|archived) is also
 * editable. The optimistic-concurrency `version` goes via the If-Match header on
 * PATCH. After save we return to the list route.
 */
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "@/api/client";
import type { Project } from "@/types/domain";
import AppCard from "@/components/AppCard.vue";
import ColorInput from "@/components/ColorInput.vue";
import { useFormSubmit, type VuetifyFormRef } from "@/composables/useFormSubmit";
import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const id = computed<string | null>(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed<boolean>(() => id.value !== null);

type ProjectStatus = "active" | "archived";

const STATUS_OPTIONS = computed(() => [
  { title: t("projects.form.statusActive"), value: "active" as ProjectStatus },
  { title: t("projects.form.statusArchived"), value: "archived" as ProjectStatus },
]);

const name = ref("");
const description = ref("");
const color = ref("");
const status = ref<ProjectStatus>("active");

const version = ref<number | null>(null);

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});

const formRef = ref<VuetifyFormRef | null>(null);
const { submit, submitting } = useFormSubmit(formRef);
const { toast } = useToast();

const required = (v: unknown): boolean | string =>
  (!!v && String(v).trim().length > 0) || t("common.required");

const loadProject = async (): Promise<void> => {
  if (!id.value) return;
  loading.value = true;
  errorMessage.value = null;
  try {
    const project = await api.get<Project>(`/v1/projects/${id.value}`);
    name.value = project.name;
    description.value = project.description ?? "";
    color.value = project.color ?? "";
    status.value = project.status;
    version.value = project.version;
  } catch (err) {
    errorMessage.value =
      err instanceof ApiError
        ? t("projects.loadOneError", { code: err.code })
        : t("projects.loadOneErrorGeneric");
  } finally {
    loading.value = false;
  }
};

const applyValidationDetails = (err: ApiError): void => {
  fieldErrors.value = {};
  if (err.details && typeof err.details === "object") {
    for (const [k, v] of Object.entries(err.details)) {
      if (typeof v === "string") fieldErrors.value[k] = v;
    }
  }
};

const save = async (): Promise<void> => {
  errorMessage.value = null;
  fieldErrors.value = {};
  try {
    if (isEdit.value && id.value) {
      const payload = {
        name: name.value.trim(),
        status: status.value,
        description: description.value.trim() || null,
        color: color.value.trim() || null,
      };
      await api.patch<Project>(`/v1/projects/${id.value}`, payload, {
        ifMatch: version.value ?? undefined,
      });
    } else {
      const payload: Record<string, unknown> = { name: name.value.trim() };
      if (description.value.trim()) payload.description = description.value.trim();
      if (color.value.trim()) payload.color = color.value.trim();
      await api.post<Project>("/v1/projects", payload);
    }
    toast.success(t("projects.saved"));
    await router.push({ name: "projects" });
  } catch (err) {
    if (err instanceof ApiError) {
      applyValidationDetails(err);
      errorMessage.value = t("projects.saveError", { code: err.code });
    } else {
      errorMessage.value = t("projects.saveErrorGeneric");
    }
    toast.error(errorMessage.value);
  }
};

onMounted(() => {
  void loadProject();
});
</script>

<template>
  <div>
    <div class="d-flex align-center mb-4" style="gap: 12px">
      <v-btn
        icon="mdi-arrow-left"
        variant="text"
        :aria-label="t('common.back')"
        @click="router.back()"
      />
      <h1 class="text-h5">{{ isEdit ? t("projects.editTitle") : t("projects.newTitle") }}</h1>
    </div>

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      role="alert"
    >
      {{ errorMessage }}
    </v-alert>

    <v-card v-if="loading" variant="outlined" rounded="lg" class="pa-8 text-center">
      <v-progress-circular indeterminate />
    </v-card>

    <v-form v-else ref="formRef" @submit.prevent="submit(save)">
      <AppCard :title="t('projects.form.details')">
        <v-row>
          <v-col cols="12" md="6">
            <v-text-field
              v-model="name"
              :label="t('projects.fields.name')"
              :rules="[required]"
              :error-messages="fieldErrors.name"
              density="comfortable"
            />
          </v-col>
          <v-col v-if="isEdit" cols="12" md="6">
            <v-select
              v-model="status"
              :items="STATUS_OPTIONS"
              :label="t('projects.fields.status')"
              :error-messages="fieldErrors.status"
              density="comfortable"
            />
          </v-col>
          <v-col cols="12" md="6">
            <ColorInput v-model="color" :label="t('projects.fields.color')" />
          </v-col>
          <v-col cols="12">
            <v-textarea
              v-model="description"
              :label="t('projects.fields.description')"
              :error-messages="fieldErrors.description"
              density="comfortable"
              rows="3"
              auto-grow
            />
          </v-col>
        </v-row>
        <template #actions>
          <v-btn variant="text" @click="router.back()">{{ t("common.cancel") }}</v-btn>
          <v-spacer />
          <v-btn color="primary" type="submit" :loading="submitting">
            {{ isEdit ? t("common.saveChanges") : t("projects.create") }}
          </v-btn>
        </template>
      </AppCard>
    </v-form>
  </div>
</template>
