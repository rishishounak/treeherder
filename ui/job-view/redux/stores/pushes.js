import pick from 'lodash/pick';
import keyBy from 'lodash/keyBy';
import max from 'lodash/max';

import { parseQueryParams } from '../../../helpers/url';
import {
  getAllUrlParams,
  getQueryString,
  getUrlParam,
  replaceLocation,
} from '../../../helpers/location';
import PushModel from '../../../models/push';
import { getTaskRunStr, isUnclassifiedFailure } from '../../../helpers/job';
import FilterModel from '../../../models/filter';
import JobModel from '../../../models/job';
import { thEvents } from '../../../helpers/constants';
import { processErrors } from '../../../helpers/http';

import { notify } from './notifications';
import { setSelectedTaskRun, clearSelectedTaskRun } from './selectedTaskRun';

export const LOADING = 'LOADING';
export const ADD_PUSHES = 'ADD_PUSHES';
export const CLEAR_PUSHES = 'CLEAR_PUSHES';
export const SET_PUSHES = 'SET_PUSHES';
export const RECALCULATE_UNCLASSIFIED_COUNTS =
  'RECALCULATE_UNCLASSIFIED_COUNTS';
export const UPDATE_TASK_RUN_MAP = 'UPDATE_TASK_RUN_MAP';

const DEFAULT_PUSH_COUNT = 10;
// Keys that, if present on the url, must be passed into the push
// polling endpoint
const PUSH_POLLING_KEYS = ['tochange', 'enddate', 'revision', 'author'];
const PUSH_FETCH_KEYS = [...PUSH_POLLING_KEYS, 'fromchange', 'startdate'];

const getRevisionTips = pushList => {
  return {
    revisionTips: pushList.map(push => ({
      revision: push.revision,
      author: push.author,
      title: push.revisions[0].comments.split('\n')[0],
    })),
  };
};

const getLastModifiedJobTime = taskRunMap => {
  const latest =
    max(
      Object.values(taskRunMap).map(
        taskRun => new Date(`${taskRun.last_modified}Z`),
      ),
    ) || new Date();

  latest.setSeconds(latest.getSeconds() - 3);
  return latest;
};

/**
 * Loops through the map of unclassified failures and checks if it is
 * within the enabled tiers and if the taskRun should be shown. This essentially
 * gives us the difference in unclassified failures and, of those taskRuns, the
 * ones that have been filtered out
 */
const doRecalculateUnclassifiedCounts = taskRunMap => {
  const filterModel = new FilterModel();
  const tiers = filterModel.urlParams.tier;
  let allUnclassifiedFailureCount = 0;
  let filteredUnclassifiedFailureCount = 0;

  Object.values(taskRunMap).forEach(taskRun => {
    if (
      isUnclassifiedFailure(taskRun) &&
      tiers.includes(String(taskRun.tier))
    ) {
      if (filterModel.showJob(taskRun)) {
        filteredUnclassifiedFailureCount++;
      }
      allUnclassifiedFailureCount++;
    }
  });
  return {
    allUnclassifiedFailureCount,
    filteredUnclassifiedFailureCount,
  };
};

const addPushes = (data, pushList, taskRunMap, setFromchange) => {
  if (data.results.length > 0) {
    const pushIds = pushList.map(push => push.id);
    const newPushList = [
      ...pushList,
      ...data.results.filter(push => !pushIds.includes(push.id)),
    ];

    newPushList.sort((a, b) => b.push_timestamp - a.push_timestamp);
    const oldestPushTimestamp =
      newPushList[newPushList.length - 1].push_timestamp;

    const newStuff = {
      pushList: newPushList,
      oldestPushTimestamp,
      ...doRecalculateUnclassifiedCounts(taskRunMap),
      ...getRevisionTips(newPushList),
    };

    // since we fetched more pushes, we need to persist the push state in the URL.
    const updatedLastRevision = newPushList[newPushList.length - 1].revision;

    if (setFromchange && getUrlParam('fromchange') !== updatedLastRevision) {
      const params = getAllUrlParams();
      params.set('fromchange', updatedLastRevision);
      replaceLocation(params);
      // We are silently updating the url params, but we still want to
      // update the ActiveFilters bar to this new change.
      window.dispatchEvent(new CustomEvent(thEvents.filtersUpdated));
    }

    return newStuff;
  }
  return {};
};

const fetchNewTaskRuns = () => {
  return async (dispatch, getState) => {
    const {
      pushes: { pushList, taskRunMap },
    } = getState();

    if (!pushList.length) {
      // If we have no pushes, then no need to get taskRuns.
      return;
    }

    const pushIds = pushList.map(push => push.id);
    const lastModified = getLastModifiedJobTime(taskRunMap);

    const resp = await JobModel.getList(
      {
        push_id__in: pushIds.join(','),
        last_modified__gt: lastModified.toISOString().replace('Z', ''),
      },
      { fetchAll: true },
    );
    const errors = processErrors([resp]);

    if (!errors.length) {
      // break the taskRuns up per push
      const { data } = resp;
      const taskRuns = data.reduce((acc, taskRun) => {
        const pushJobs = acc[taskRun.push_id]
          ? [...acc[taskRun.push_id], taskRun]
          : [taskRun];
        return { ...acc, [taskRun.push_id]: pushJobs };
      }, {});
      // If a taskRun is selected, and one of the taskRuns we just fetched is the
      // updated version of that selected taskRun, then send that with the event.
      const selectedTaskRun = getUrlParam('selectedTaskRun');
      const updatedSelectedJob = selectedTaskRun
        ? data.find(taskRun => getTaskRunStr(taskRun) === selectedTaskRun)
        : null;

      window.dispatchEvent(
        new CustomEvent(thEvents.applyNewJobs, {
          detail: { taskRuns },
        }),
      );
      if (updatedSelectedJob) {
        dispatch(setSelectedTaskRun(updatedSelectedJob));
      }
    } else {
      for (const error of errors) {
        notify(error, 'danger', { sticky: true });
      }
    }
  };
};

const doUpdateJobMap = (taskRunList, taskRunMap, decisionTaskMap, pushList) => {
  if (taskRunList.length) {
    // lodash ``keyBy`` is significantly faster than doing a ``reduce``
    return {
      taskRunMap: { ...taskRunMap, ...keyBy(taskRunList, 'id') },
      decisionTaskMap: {
        ...decisionTaskMap,
        ...keyBy(
          taskRunList
            .filter(
              taskRun =>
                taskRun.job_type_name.includes('Decision Task') &&
                taskRun.result === 'success' &&
                taskRun.job_type_symbol === 'D',
            )
            .map(taskRun => ({
              push_id: taskRun.push_id,
              id: taskRun.task_id,
              run: taskRun.retry_id,
            })),
          'push_id',
        ),
      },
      taskRunsLoaded: pushList.every(push => push.taskRunsLoaded),
    };
  }
  return {};
};

export const fetchPushes = (
  count = DEFAULT_PUSH_COUNT,
  setFromchange = false,
) => {
  return async (dispatch, getState) => {
    const {
      pushes: { pushList, taskRunMap, oldestPushTimestamp },
    } = getState();

    dispatch({ type: LOADING });

    // Only pass supported query string params to this endpoint.
    const options = {
      ...pick(parseQueryParams(getQueryString()), PUSH_FETCH_KEYS),
    };

    if (oldestPushTimestamp) {
      // If we have an oldestTimestamp, then this isn't our first fetch,
      // we're fetching more pushes.  We don't want to limit this fetch
      // by the current ``fromchange`` or ``tochange`` value.  Deleting
      // these params here do not affect the params on the location bar.
      delete options.fromchange;
      delete options.tochange;
      options.push_timestamp__lte = oldestPushTimestamp;
    }
    if (!options.fromchange) {
      options.count = count;
    }
    const { data, failureStatus } = await PushModel.getList(options);

    if (!failureStatus) {
      return dispatch({
        type: ADD_PUSHES,
        pushResults: addPushes(
          data.results.length ? data : { results: [] },
          pushList,
          taskRunMap,
          setFromchange,
        ),
      });
    }
    dispatch(notify('Error retrieving push data!', 'danger', { sticky: true }));
    return {};
  };
};

export const pollPushes = () => {
  return async (dispatch, getState) => {
    const {
      pushes: { pushList, taskRunMap },
    } = getState();
    // these params will be passed in each time we poll to remain
    // within the constraints of the URL params
    const locationSearch = parseQueryParams(getQueryString());
    const pushPollingParams = PUSH_POLLING_KEYS.reduce(
      (acc, prop) =>
        locationSearch[prop] ? { ...acc, [prop]: locationSearch[prop] } : acc,
      {},
    );

    if (pushList.length === 1 && locationSearch.revision) {
      // If we are on a single revision, no need to poll for more pushes, but
      // we need to keep polling for taskRuns.
      dispatch(fetchNewTaskRuns());
    } else {
      if (pushList.length) {
        // We have a range of pushes, but not bound to a single push,
        // so get only pushes newer than our latest.
        pushPollingParams.fromchange = pushList[0].revision;
      }
      // We will either have a ``revision`` param, but no push for it yet,
      // or a ``fromchange`` param because we have at least 1 push already.
      const { data, failureStatus } = await PushModel.getList(
        pushPollingParams,
      );

      if (!failureStatus) {
        dispatch({
          type: ADD_PUSHES,
          pushResults: addPushes(
            data.results.length ? data : { results: [] },
            pushList,
            taskRunMap,
            false,
          ),
        });
        dispatch(fetchNewTaskRuns());
      } else {
        dispatch(
          notify('Error fetching new push data', 'danger', { sticky: true }),
        );
      }
    }
  };
};

/**
 * Get the next batch of pushes based on our current offset.
 */
export const fetchNextPushes = count => {
  const params = getAllUrlParams();

  if (params.has('revision')) {
    // We are viewing a single revision, but the user has asked for more.
    // So we must replace the ``revision`` param with ``tochange``, which
    // will make it just the top of the range.  We will also then get a new
    // ``fromchange`` param after the fetch.
    const revision = params.get('revision');
    params.delete('revision');
    params.set('tochange', revision);
  } else if (params.has('startdate')) {
    // We are fetching more pushes, so we don't want to limit ourselves by
    // ``startdate``.  And after the fetch, ``startdate`` will be invalid,
    // and will be replaced on the location bar by ``fromchange``.
    params.delete('startdate');
  }
  replaceLocation(params);
  return fetchPushes(count, true);
};

export const clearPushes = () => ({ type: CLEAR_PUSHES });

export const setPushes = (pushList, taskRunMap) => ({
  type: SET_PUSHES,
  pushResults: {
    pushList,
    taskRunMap,
    ...getRevisionTips(pushList),
    ...doRecalculateUnclassifiedCounts(taskRunMap),
    oldestPushTimestamp: pushList[pushList.length - 1].push_timestamp,
  },
});

export const recalculateUnclassifiedCounts = filterModel => ({
  type: RECALCULATE_UNCLASSIFIED_COUNTS,
  filterModel,
});

export const updateJobMap = taskRunList => ({
  type: UPDATE_TASK_RUN_MAP,
  taskRunList,
});

export const updateRange = range => {
  return (dispatch, getState) => {
    const {
      pushes: { pushList, taskRunMap },
    } = getState();
    const { revision } = range;
    // change the range of pushes.  might already have them.
    const revisionPushList = revision
      ? pushList.filter(push => push.revision === revision)
      : [];

    window.dispatchEvent(new CustomEvent(thEvents.clearPinboard));
    if (revisionPushList.length) {
      const { id: pushId } = revisionPushList[0];
      const revisionJobMap = Object.entries(taskRunMap).reduce(
        (acc, [id, taskRun]) =>
          taskRun.push_id === pushId ? { ...acc, [id]: taskRun } : acc,
        {},
      );
      dispatch(clearSelectedTaskRun(0));
      // We already have the one revision they're looking for,
      // so we can just erase everything else.
      dispatch(setPushes(revisionPushList, revisionJobMap));
    } else {
      // Clear and refetch everything.  We can't be sure if what we
      // already have is partially correct and just needs fill-in.
      dispatch(clearPushes());
      return dispatch(fetchPushes());
    }
  };
};

export const initialState = {
  pushList: [],
  taskRunMap: {},
  decisionTaskMap: {},
  revisionTips: [],
  taskRunsLoaded: false,
  loadingPushes: true,
  oldestPushTimestamp: null,
  allUnclassifiedFailureCount: 0,
  filteredUnclassifiedFailureCount: 0,
};

export const reducer = (state = initialState, action) => {
  const { taskRunList, pushResults, setFromchange } = action;
  const { pushList, taskRunMap, decisionTaskMap } = state;
  switch (action.type) {
    case LOADING:
      return { ...state, loadingPushes: true };
    case ADD_PUSHES:
      return { ...state, loadingPushes: false, ...pushResults, setFromchange };
    case CLEAR_PUSHES:
      return { ...initialState };
    case SET_PUSHES:
      return { ...state, loadingPushes: false, ...pushResults };
    case RECALCULATE_UNCLASSIFIED_COUNTS:
      return { ...state, ...doRecalculateUnclassifiedCounts(taskRunMap) };
    case UPDATE_TASK_RUN_MAP:
      return {
        ...state,
        ...doUpdateJobMap(taskRunList, taskRunMap, decisionTaskMap, pushList),
      };
    default:
      return state;
  }
};
